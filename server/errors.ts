// Thrown by validation that happens inside a db.transaction() so the transaction rolls back AND
// the route returns the right HTTP status/body — a thrown Error inside better-sqlite3's
// transaction() re-throws after rollback, so the outer try/catch still sees it. Shared between
// server/routes.ts and server/invoiceEdit.ts so `instanceof` checks work across both modules.
//
// The third constructor argument accepts either a bare `code` string (the original shape, kept so
// existing call sites don't need touching) or an options object `{ code?, field?, ...extra }`:
//   - `field` is a hint for the UI about which form field caused the error (e.g. `'stakeholder_id'`,
//     `'items.0.unit_price'`, `'payments'`) so it can be shown inline instead of just a toast.
//   - any other keys (e.g. `available` on STORE_CREDIT_EXCEEDED) are carried through as `extra` and
//     spread onto the JSON error response alongside `error`/`code`/`field`.
export interface ValidationErrorOptions {
  code?: string;
  field?: string;
  [key: string]: any;
}

export class ValidationError extends Error {
  status: number;
  code?: string;
  field?: string;
  extra?: Record<string, any>;
  constructor(message: string, status = 400, opts?: string | ValidationErrorOptions) {
    super(message);
    this.status = status;
    if (typeof opts === 'string') {
      this.code = opts;
    } else if (opts) {
      const { code, field, ...extra } = opts;
      this.code = code;
      this.field = field;
      if (Object.keys(extra).length) this.extra = extra;
    }
  }
}

// Shared by every route that catches a ValidationError — { error, code?, field?, ...extra }.
export function validationErrorBody(error: ValidationError) {
  return {
    error: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(error.field ? { field: error.field } : {}),
    ...(error.extra || {}),
  };
}
