import type { ApiErrorBody } from '@helpdesk/shared';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** True for failures that never reached the server (offline, aborted): safe to retry. */
export const isNetworkError = (err: unknown): boolean => err instanceof TypeError;

function toError(status: number, body: unknown, retryAfter: string | null): ApiRequestError {
  const parsed = body as Partial<ApiErrorBody> | null;
  return new ApiRequestError(
    status,
    parsed?.error?.code ?? 'unknown',
    parsed?.error?.message ?? `HTTP ${status.toString()}`,
    body,
    retryAfter ? Number(retryAfter) : undefined,
  );
}

/** All requests go to /api/* on the same origin; Next proxies them to the api service. */
export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, headers, ...rest } = init;
  const merged = new Headers(headers);
  if (json !== undefined) merged.set('Content-Type', 'application/json');
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...rest,
    headers: merged,
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw toError(res.status, data, res.headers.get('Retry-After'));
  return data as T;
}

export interface UploadHandle {
  promise: Promise<import('@helpdesk/shared').Attachment>;
  abort: () => void;
}

/** XMLHttpRequest upload: gives real progress events and can be cancelled. */
export function uploadAttachment(file: File, onProgress: (percent: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<import('@helpdesk/shared').Attachment>((resolve, reject) => {
    xhr.open('POST', '/api/attachments');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as import('@helpdesk/shared').Attachment);
      } else {
        reject(toError(xhr.status, body, null));
      }
    };
    xhr.onerror = () => {
      reject(new TypeError('network error'));
    };
    xhr.onabort = () => {
      reject(new DOMException('aborted', 'AbortError'));
    };
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
  return {
    promise,
    abort: () => {
      xhr.abort();
    },
  };
}
