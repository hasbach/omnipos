type QueryCall = { table: string; steps: Array<{ method: string; args: any[] }> };
type RpcCall = { name: string; args: any };
type Call = QueryCall | RpcCall;

let latest: ReturnType<typeof makeFakeSupabase>;

export function makeFakeSupabase() {
  const rows = new Map<string, any[]>();
  const handlers = new Map<string, (args: any) => any>();
  const recorded: Call[] = [];
  const setRows = (table: string, value: any[]) => { rows.set(table, value); };
  const onRpc = (name: string, fn: (args: any) => any) => { handlers.set(name, fn); };
  const calls = () => recorded;
  const fake = {
    setRows, onRpc, calls,
    auth: {
      setSession: async (tokens: any) => ({ data: { session: tokens }, error: null }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from(table: string) {
      const request: QueryCall = { table, steps: [] };
      recorded.push(request);
      const builder: any = {};
      for (const method of ['select', 'eq', 'gte', 'gt', 'or', 'order', 'limit', 'in', 'is', 'not', 'upsert', 'update', 'delete']) {
        builder[method] = (...args: any[]) => { request.steps.push({ method, args }); return builder; };
      }
      builder.then = (resolve: any, reject: any) => Promise.resolve({ data: rows.get(table) || [], error: null }).then(resolve, reject);
      return builder;
    },
    async rpc(name: string, args: any) {
      recorded.push({ name, args });
      const value = await handlers.get(name)?.(args);
      if (value && typeof value === 'object' && 'error' in value) return { data: null, ...value };
      return { data: value ?? null, error: null };
    },
  };
  latest = fake;
  return fake;
}

// Module helpers target the latest client; instance helpers keep multi-client fixtures isolated.
export const setRows = (table: string, rows: any[]) => latest.setRows(table, rows);
export const onRpc = (name: string, fn: (args: any) => any) => latest.onRpc(name, fn);
export const calls = () => latest.calls();
