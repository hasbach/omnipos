// Thrown by validation that happens inside a db.transaction() so the transaction rolls back AND
// the route returns the right HTTP status/body — a thrown Error inside better-sqlite3's
// transaction() re-throws after rollback, so the outer try/catch still sees it. Shared between
// server/routes.ts and server/invoiceEdit.ts so `instanceof` checks work across both modules.
export class ValidationError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
