import { randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { LIMITS, type AllowedMimeType, type Attachment } from '@helpdesk/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { Clock } from '../common/clock.js';
import { ApiError, badRequest, notFound } from '../common/errors.js';
import { DB, type Db, type DbOrTx } from '../db/db.js';
import { attachments } from '../db/schema.js';
import { messageVisibility, ticketScope } from '../tickets/ticket-access.js';
import { detectMimeType, sanitizeFilename } from './detect-type.js';

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  size: number;
}

interface AttachmentAccessRow {
  id: string;
  filename: string;
  mime_type: AllowedMimeType;
  size: number;
  storage_key: string;
}

@Injectable()
export class AttachmentsService implements OnModuleInit {
  private readonly dir: string;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly clock: Clock,
  ) {
    this.dir = path.resolve(config.ATTACHMENTS_DIR);
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /** Storage keys are uuids generated here, so joining them to the directory is safe. */
  filePath(storageKey: string): string {
    return path.join(this.dir, storageKey);
  }

  async upload(user: AuthUser, file: UploadedFile | undefined): Promise<Attachment> {
    if (!file) throw badRequest('Multipart field "file" is required');
    if (file.size > LIMITS.attachmentMaxBytes) {
      throw new ApiError(
        413,
        'payload_too_large',
        `File is larger than ${LIMITS.attachmentMaxMb.toString()} MB`,
      );
    }
    if (file.size === 0) throw badRequest('File is empty');
    const mimeType = detectMimeType(file.buffer);
    if (!mimeType) {
      throw new ApiError(
        415,
        'unsupported_media_type',
        'Only images (png, jpeg, gif, webp), PDF and plain text are allowed',
      );
    }
    const storageKey = randomUUID();
    await writeFile(this.filePath(storageKey), file.buffer, { flag: 'wx' });
    try {
      // Quota check and insert are one transaction under a per-user advisory lock, so parallel
      // uploads cannot all pass the check and overshoot the quota.
      const row = await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'upload:' + user.id}))`);
        await this.assertQuota(tx, user.id, file.size);
        const [inserted] = await tx
          .insert(attachments)
          .values({
            uploaderId: user.id,
            filename: sanitizeFilename(file.originalname, LIMITS.attachmentFilenameMax),
            mimeType,
            size: file.size,
            storageKey,
            createdAt: this.clock.now(),
          })
          .returning();
        return inserted;
      });
      if (!row) throw new Error('attachment insert failed');
      return { id: row.id, filename: row.filename, mimeType: row.mimeType, size: row.size };
    } catch (err) {
      await rm(this.filePath(storageKey), { force: true });
      throw err;
    }
  }

  /** Uploaded-but-unattached files per user are capped so one client cannot fill the disk. */
  private async assertQuota(db: DbOrTx, userId: string, incomingBytes: number): Promise<void> {
    const res = await db.execute<{ n: string; bytes: string }>(sql`
      select count(*)::text as n, coalesce(sum(size), 0)::text as bytes
      from attachments where uploader_id = ${userId} and message_id is null`);
    const row = res.rows[0];
    const n = Number(row?.n ?? 0);
    const bytes = Number(row?.bytes ?? 0);
    if (
      n >= LIMITS.unboundAttachmentsMax ||
      bytes + incomingBytes > LIMITS.unboundAttachmentsMaxBytes
    ) {
      throw new ApiError(
        422,
        'attachment_quota_exceeded',
        `Too many unattached uploads (max ${LIMITS.unboundAttachmentsMax.toString()} files / ${(LIMITS.unboundAttachmentsMaxBytes / 1024 / 1024).toString()} MB); attach or remove them first`,
      );
    }
  }

  /**
   * Unbound attachments: uploader only. Bound: the viewer must be able to see the ticket
   * *and* the message (customers never get attachments of internal notes). Otherwise 404.
   */
  async open(
    user: AuthUser,
    id: string,
  ): Promise<{ meta: AttachmentAccessRow; stream: ReadStream }> {
    const res = await this.db.execute<AttachmentAccessRow & Record<string, unknown>>(sql`
      select a.id, a.filename, a.mime_type, a.size, a.storage_key
      from attachments a
      left join messages m on m.id = a.message_id
      left join tickets t on t.id = m.ticket_id
      where a.id = ${id}
        and (
          (a.message_id is null and a.uploader_id = ${user.id})
          or (a.message_id is not null and ${ticketScope(user)} and ${messageVisibility(user)})
        )`);
    const meta = res.rows[0];
    if (!meta) throw notFound('Attachment not found');
    const stream = createReadStream(this.filePath(meta.storage_key));
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => {
        resolve();
      });
      stream.once('error', () => {
        reject(notFound('Attachment file is missing'));
      });
    });
    return { meta, stream };
  }
}
