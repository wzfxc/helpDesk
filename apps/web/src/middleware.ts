import { NextResponse, type NextRequest } from 'next/server';
import { LIMITS } from '@helpdesk/shared';

/**
 * Request-size guard in front of the /api rewrite. Without it Next buffers the body up to
 * `middlewareClientMaxBodySize`, and a bigger one makes the proxy socket hang up (a bare 500).
 * Oversized requests are answered here with the same 413 body the api uses.
 *
 * Only the Content-Length header is inspected (browsers always send it for uploads and JSON);
 * the api enforces the exact limits, this only has to stop what the proxy cannot digest.
 */
const MULTIPART_OVERHEAD = 64 * 1024; // boundaries + headers around the 10 MiB file

export function middleware(req: NextRequest) {
  const length = Number(req.headers.get('content-length') ?? 0);
  const isUpload = req.method === 'POST' && req.nextUrl.pathname === '/api/attachments';
  const max = isUpload ? LIMITS.attachmentMaxBytes + MULTIPART_OVERHEAD : LIMITS.jsonBodyMaxBytes;
  if (Number.isFinite(length) && length > max) {
    return NextResponse.json(
      {
        error: {
          code: 'payload_too_large',
          message: isUpload
            ? `File is larger than ${LIMITS.attachmentMaxMb.toString()} MB`
            : 'Request body too large',
        },
      },
      { status: 413 },
    );
  }
  return NextResponse.next();
}

export const config = { matcher: '/api/:path*' };
