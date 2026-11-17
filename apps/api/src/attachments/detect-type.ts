import type { AllowedMimeType } from '@helpdesk/shared';

const startsWith = (buf: Uint8Array, sig: readonly number[], offset = 0): boolean =>
  buf.length >= offset + sig.length && sig.every((b, i) => buf[offset + i] === b);

/**
 * Detects the file type from its content (magic bytes), never from the name or the
 * client-declared Content-Type. Returns null for anything outside the whitelist.
 */
export function detectMimeType(buf: Uint8Array): AllowedMimeType | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (
    startsWith(buf, [0x47, 0x49, 0x46, 0x38]) &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return 'image/gif';
  }
  // RIFF....WEBP
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (isPlainText(buf)) return 'text/plain';
  return null;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/** Valid UTF-8 without NUL or other binary control characters (tab, CR, LF, FF allowed). */
export function isPlainText(buf: Uint8Array): boolean {
  if (buf.length === 0) return false;
  let text: string;
  try {
    text = decoder.decode(buf);
  } catch {
    return false;
  }
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c) return false;
    if (c === 0x7f) return false;
  }
  return true;
}

/** Strips paths and control characters; the name is only ever echoed back, never used on disk. */
export function sanitizeFilename(name: string, max = 255): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_').trim();
  return (cleaned || 'file').slice(0, max);
}

/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback and a UTF-8 name. */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
