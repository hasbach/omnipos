// Pluggable Google OR-Tools Cloud Adapter (for future Python FastAPI / CP-SAT microservice).
// Activated when `OR_SOLVER_URL` is configured; automatically falls back to local offline `HighsWasmAdapter`
// whenever offline, unconfigured, or if the cloud solver times out.
import { HighsWasmAdapter } from "./highsAdapter.js";
import type { OrOptimizationProblem, OrOptimizationSolution, SolverAdapter } from "./types.js";

export class OrToolsCloudAdapter implements SolverAdapter {
  readonly name = "ortools-cloud" as const;
  private readonly fallback = new HighsWasmAdapter();

  constructor(private readonly endpointUrl: string, private readonly timeoutMs = 8000) {}

  async solve(problem: OrOptimizationProblem): Promise<OrOptimizationSolution> {
    if (!this.endpointUrl) {
      return this.fallback.solve(problem);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.endpointUrl.replace(/\/$/, "")}/solve/restock-cash`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(problem),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Cloud solver HTTP ${res.status}`);
      const data = (await res.json()) as OrOptimizationSolution;
      return { ...data, solver: "ortools-cloud" };
    } catch (err) {
      console.warn("[OR] Cloud OR-Tools solver unreachable, falling back to local HiGHS WASM:", (err as Error)?.message);
      return this.fallback.solve(problem);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function getActiveSolver(): SolverAdapter {
  const url = process.env.OR_SOLVER_URL?.trim();
  if (url) return new OrToolsCloudAdapter(url);
  return new HighsWasmAdapter();
}
