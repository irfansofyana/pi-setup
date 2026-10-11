import { createSupervisor, type StartRequest } from "./supervisor.ts";
import { createManagerDriverFactory } from "./manager-driver.ts";
import { ThreadManager } from "./upstream/src/orch/manager.ts";
import { canonicalPath } from "./upstream/src/orch/paths.ts";
import { limits, validateControl, type Control, type Receipt, type Rejection } from "./contracts.ts";
import type { ThreadEvent } from "./upstream/src/types.ts";
import type { AgentType, DriverOptions } from "./upstream/src/types.ts";

type Handle = { agentId: string; threadId: string; runId: string };
type Admission = Handle | Rejection;
export type NamedSpawn = { path: string; type: string; task: string; wait?: boolean; timeoutMs?: number;
  files?: string[]; model?: string; thinking?: string; maxTurns?: number };

/** One upstream lifecycle owner, backed by one bounded execution-policy pool. */
export function createManagedSupervisor(options: Parameters<typeof createSupervisor>[0], hooks: { maxLevels?:number;onEvent?(event: ThreadEvent): void; getType?(name: string): AgentType;onDriver?(driver:DriverOptions):void } = {}) {
  const raw = createSupervisor(options);
  const requests = new Map<string, Omit<StartRequest, "prompt">>();
  const paths = new Map<string, string>();
  const allocations = new Map<string, (value: Admission) => void>();
  const admitted = new Map<string, Handle>();
  const continuations = new Map<string, Promise<Receipt>>();
  let continuationCount = 0;
  let serial = 0;
  const rejected = (code: Rejection["code"] = "invalid_request"): Rejection => ({ ok: false, code });
  const drivers = createManagerDriverFactory({ supervisor: raw, consumeResults: false,
    onDriver:hooks.onDriver,
    requestFor: path => { const request = requests.get(path); if (!request) throw Error("Missing reviewed launch request"); return request; },
    onAllocated(path, value) { const handle = { agentId: value.agentId, threadId: value.threadId, runId: value.runId }; paths.set(handle.threadId, path); admitted.set(path, handle); allocations.get(path)?.(handle); allocations.delete(path); },
    onRejected(path, error) { allocations.get(path)?.(error as Rejection); allocations.delete(path); },
  });
  const manager = new ThreadManager({ createDriver: drivers, rootSnapshot: () => [], toolsFor: () => [], inheritContext:false,
    getType(name) {
      if (hooks.getType) return { ...hooks.getType(name), tools: {} };
      if (!["researcher", "code-mapper", "reviewer", "builder", "Explore"].includes(name)) throw Error("Unknown reviewed role");
      return { name, description: name, systemPrompt: "", tools: [], thinkingLevel: "medium" };
    }, onEvent: hooks.onEvent, maxLevels: hooks.maxLevels??2, maxThreads: options.threads ?? limits.threadsPerRoot,
    // Only the shared policy pool schedules SDK work; manager counts all retained threads.
    maxConcurrent: options.threads ?? limits.threadsPerRoot,
  });
  async function allocation(path: string, launch: () => Promise<unknown>): Promise<Admission> {
    const pending = new Promise<Admission>(resolve => allocations.set(path, resolve));
    try {
      await launch();
      return await Promise.race([pending, manager.wait("/root", path).then(() => admitted.get(path) ?? rejected())]);
    } finally { allocations.delete(path); }
  }
  async function start(value: unknown, namedPath?: string, timeoutMs?: number, detached=true, caller="/root") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return rejected();
    const { prompt, ...request } = value as StartRequest;
    if (typeof prompt !== "string" || !prompt.trim()) return rejected();
    const path = namedPath ? canonicalPath(namedPath,caller) : `${caller}/task-${++serial}`;
    if (path==="/root" || requests.has(path)) return rejected();
    requests.set(path, structuredClone(request));
    try {
      const result = await allocation(path, () => manager.spawn(caller, { path, type: request.role ?? "researcher", task: prompt, wait: false, timeoutMs,detached }));
      if ("ok" in result) { await manager.wait("/root", path); manager.forget(path); requests.delete(path); return result; }
      return { ...result, ok: true as const, version: 1 as const, controlId: `control-manager-${serial}`, status: "accepted" as const };
    } catch (error) {
      if (!admitted.has(path)) requests.delete(path);
      return /limit|capacity/i.test(String(error)) ? { ...rejected("backpressure"), domain: "threads" as const, recovery: "retry_after_drain" as const } : rejected();
    }
  }
  async function spawnNamed(args: NamedSpawn, signal?: AbortSignal) {
    const path = canonicalPath(args.path);
    if (!path.startsWith("/root/") || path.split("/").length !== 3) throw Error("Agent depth limit reached");
    if (requests.has(path)) throw Error(`Thread ${path} already exists; use agent_steer to resume it`);
    const { files, model, thinking, maxTurns } = args;
    requests.set(path, { role: args.type, ...(files ? { files: structuredClone(files) } : {}), ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}), ...(maxTurns !== undefined ? { maxTurns } : {}) });
    try { return await manager.spawn("/root", { ...args, path }, signal); }
    catch (error) { if (!manager.list().some(view => view.path === path)) requests.delete(path); throw error; }
  }
  async function applyControl(request: Control): Promise<Receipt> {
    const current = raw.inspect(request?.threadId), path = paths.get(request?.threadId);
    if (!path || !validateControl(request, current?.runId).ok) return raw.control(request);
    if (request.operation === "follow_up" || request.operation === "resume") {
      // Upstream distinguishes same-turn steering from settled-thread continuation.
      // Formal active-run queuing remains the policy pool's compatibility operation.
      if (!current?.result) return raw.control(request);
      await manager.wait("/root", path);
      if (request.operation === "resume" && !current.result.complete) return raw.control(request);
      const old = admitted.get(path);
      const result = await allocation(path, () => manager.steer("/root", path, request.message));
      if ("ok" in result || result.runId === old?.runId) return { version: 1, controlId: `control-manager-${++serial}`, status: "rejected", error: "ok" in result ? result : rejected("unsupported_field") };
      return { version: 1, controlId: `control-manager-${++serial}`, status: "queued", runId: result.runId };
    }
    if (request.operation === "close") {
      await manager.stop("/root", path);
      const result = await raw.control(request);
      if (result.status !== "rejected") { manager.forget(path); requests.delete(path); admitted.delete(path); paths.delete(request.threadId); }
      return result;
    }
    if (request.operation === "interrupt" && !current?.result) {
      await manager.stop("/root", path);
      return { version: 1, controlId: `control-manager-${++serial}`, runId: current?.runId, status: "handled" };
    }
    return raw.control(request);
  }
  function control(request: Control): Promise<Receipt> {
    if (!["follow_up", "resume"].includes(request?.operation)) return applyControl(request);
    if (continuationCount >= limits.pendingRunsPerRoot) return Promise.resolve({ version: 1, controlId: `control-manager-${++serial}`, status: "rejected", error: { ok: false, code: "backpressure", domain: "pending_runs", recovery: "retry_after_drain" } });
    continuationCount++;
    const previous = continuations.get(request.threadId);
    const pending = (previous?.catch(() => {}) ?? Promise.resolve()).then(() => applyControl(request));
    continuations.set(request.threadId, pending);
    void pending.finally(() => { continuationCount--; if (continuations.get(request.threadId) === pending) continuations.delete(request.threadId); }).catch(() => {});
    return pending;
  }
  return { ...raw, manager, start, control, spawnNamed, pathFor: (threadId: string) => paths.get(threadId), handleFor: (path: string) => admitted.get(canonicalPath(path)),
    async dispose() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Start policy drain immediately; upstream joins must not bypass quarantine.
        await Promise.race([Promise.all([manager.shutdown(), drivers.shutdown()]), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Error("Manager cleanup unconfirmed; owner quarantined")), options.cleanupMs ?? 10000);
        })]);
        requests.clear(); paths.clear(); allocations.clear(); admitted.clear();
      } finally { if (timer) clearTimeout(timer); }
    } };
}
