import { getActiveSession } from './session.js';

export type CloudResult<T> = { ok: true; value: T } | { ok: false; reason: 'offline' | 'failed'; error?: unknown };

export class CloudTimeoutError extends Error {
  constructor() { super('Cloud call timed out'); this.name = 'CloudTimeoutError'; }
}

export function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CloudTimeoutError()), ms);
    Promise.resolve(p).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

type RpcCaller = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
let rpcCaller: RpcCaller | null = null;
export function __setRpcCaller(fn: RpcCaller | null): void { rpcCaller = fn; }

export async function callRpc<T>(tenantId: number, fn: string, args: Record<string, unknown>, { timeoutMs = 10000 } = {}): Promise<CloudResult<T>> {
  const session = getActiveSession();
  if (!session || session.localId !== tenantId) return { ok: false, reason: 'offline' };
  try {
    const result = await withTimeout(rpcCaller ? rpcCaller(fn, args) : session.client.rpc(fn, args), timeoutMs);
    if (result.error) return { ok: false, reason: 'failed', error: result.error };
    return { ok: true, value: result.data as T };
  } catch (error) {
    return { ok: false, reason: 'offline', error };
  }
}
