// Tiny fetch wrappers used by page agents. Parses JSON and throws Error(server `error` message) on !ok.
// The thrown Error also carries `code`/`field`/`available` (when the server sent them — see
// server/errors.ts's ValidationError/validationErrorBody) so callers can pass it straight to
// src/lib/serverErrors.ts's translateServerError() for a localized message.

export interface ApiError extends Error {
  code?: string;
  field?: string;
  available?: number;
}

async function parse(res: Response) {
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : await res.text().catch(() => null);

  if (!res.ok) {
    const message =
      (body && typeof body === 'object' && 'error' in body && (body as any).error) ||
      (typeof body === 'string' && body) ||
      `Request failed (${res.status})`;
    const err = new Error(message) as ApiError;
    if (body && typeof body === 'object') {
      if ('code' in body) err.code = (body as any).code;
      if ('field' in body) err.field = (body as any).field;
      if ('available' in body) err.available = (body as any).available;
    }
    throw err;
  }

  return body;
}

function withQuery(url: string, params?: Record<string, unknown>): string {
  if (!params) return url;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, String(v));
  }
  const qs = usp.toString();
  return qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
}

export const api = {
  get<T = any>(url: string, params?: Record<string, unknown>): Promise<T> {
    return fetch(withQuery(url, params)).then(parse);
  },
  post<T = any>(url: string, data?: unknown): Promise<T> {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    }).then(parse);
  },
  put<T = any>(url: string, data?: unknown): Promise<T> {
    return fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    }).then(parse);
  },
  del<T = any>(url: string, data?: unknown): Promise<T> {
    return fetch(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    }).then(parse);
  },
};
