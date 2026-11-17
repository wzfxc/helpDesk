export const LIMITS = {
  subjectMax: 200,
  messageBodyMax: 20_000,
  tagMax: 40,
  tagsPerTicket: 20,
  /** "10 MB" in the spec is 10 MiB = 10 * 1024 * 1024 bytes (exactly this size is accepted). */
  attachmentMaxBytes: 10 * 1024 * 1024,
  /** Same limit in MiB, for user-visible messages ("10 MB"). */
  attachmentMaxMb: 10,
  attachmentsPerMessage: 5,
  attachmentFilenameMax: 255,
  /** Uploaded but not yet attached to a message (cleaned up after `orphanAttachmentHours`). */
  unboundAttachmentsMax: 20,
  unboundAttachmentsMaxBytes: 100 * 1024 * 1024,
  /** JSON / urlencoded request body limit for every endpoint except POST /attachments. */
  jsonBodyMaxBytes: 256 * 1024,
  /** multipart/form-data guards (busboy): one file part + a few tiny fields, nothing else. */
  multipartMaxParts: 6,
  multipartMaxFields: 5,
  multipartFieldBytes: 1024,
  multipartFieldNameBytes: 100,
  multipartMaxHeaderPairs: 50,
  /** Per-user throttles (429 rate_limited + Retry-After), sliding window. */
  rate: {
    ticketCreate: { max: 60, windowMs: 10 * 60_000 },
    message: { max: 60, windowMs: 60_000 },
    upload: { max: 60, windowMs: 10 * 60_000 },
    /** per user and ticket; the web client already sends at most one every 2.5 s */
    typing: { max: 1, windowMs: 1_000 },
  },
  /** Max simultaneous SSE connections per user (extra tabs beyond this get 429). */
  sseMaxPerUser: 8,
  /** Highest accepted optimistic-locking version. */
  versionMax: 2_147_483_647,
  bulkMax: 200,
  pageSizeDefault: 50,
  pageSizeMax: 100,
  searchQueryMax: 200,
  cursorMax: 1_000,
  savedViewQueryMax: 2_000,
  ratingCommentMax: 2_000,
  cannedTitleMax: 120,
  cannedBodyMax: 10_000,
  viewNameMax: 80,
  emailMax: 254,
  passwordMax: 200,
  /** Notify the assignee this many minutes before an SLA deadline. */
  slaWarningMinutes: 30,
  /** "At risk" filter / "SLA on fire" view threshold. */
  slaRiskMinutes: 60,
  /** resolved -> closed after this many calendar days without a customer reply. */
  autoCloseDays: 3,
  /** Attachments not bound to a message are deleted after this many hours. */
  orphanAttachmentHours: 24,
  /** Business minutes in one working day (Mon–Fri 09:00–18:00). */
  businessDayMinutes: 9 * 60,
} as const;

export const ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
] as const;
export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export const isAllowedMime = (value: string): value is AllowedMimeType =>
  (ALLOWED_MIME_TYPES as readonly string[]).includes(value);

/** `HD-1042` */
export const formatTicketNumber = (n: number): string => `HD-${n}`;
