import {
  Controller,
  Get,
  Param,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AttachmentSchema, IdSchema, LIMITS, type Attachment } from '@helpdesk/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators.js';
import { ApiZodResponse } from '../common/openapi.js';
import { zod } from '../common/zod.pipe.js';
import { AttachmentsService, type UploadedFile as File } from './attachments.service.js';
import { contentDisposition } from './detect-type.js';

@ApiTags('attachments')
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  /** multipart/form-data, field `file`, ≤ 10 MB (413), type sniffed from content (415). */
  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
  })
  @ApiZodResponse(201, AttachmentSchema)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: LIMITS.attachmentMaxBytes, files: 1, fields: 5 },
    }),
  )
  upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: File | undefined,
  ): Promise<Attachment> {
    return this.attachments.upload(user, file);
  }

  @Get(':id')
  async download(
    @CurrentUser() user: AuthUser,
    @Param('id', zod(IdSchema)) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { meta, stream } = await this.attachments.open(user, id);
    const inline = meta.mime_type.startsWith('image/') || meta.mime_type === 'application/pdf';
    res.set({
      'Content-Type':
        meta.mime_type === 'text/plain' ? 'text/plain; charset=utf-8' : meta.mime_type,
      'Content-Length': String(meta.size),
      'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', meta.filename),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=0, no-cache',
    });
    return new StreamableFile(stream);
  }
}
