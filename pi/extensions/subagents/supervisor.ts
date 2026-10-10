// In-memory M2 lifecycle core; deliberately unreachable from the inert entrypoint.
import { limits, utf8Bytes, validateControl } from "./contracts.ts";
import type { Control, Receipt, RunResult, RunState, Rejection } from "./contracts.ts";
import { resolveContext } from "./context.ts";
import type { ContextRequest, ContextSnapshot } from "./context.ts";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export type Backend = { run(prompt: string, emit: (event: any) => void): Promise<{ outcome: "completed" | "failed" | "interrupted"; complete: boolean }>; artifacts?():Promise<RunResult["artifacts"]>;hasRetainedContext?(): boolean; abort(): Promise<void>; dispose(): Promise<void>; message?(text: string): Promise<{ status: "unknown_delivery" | "rejected" }>; steer?(text: string): Promise<{ status: "queued" | "handled" | "unknown_delivery" | "rejected" }> };
export type Budget = { softTurns: number; hardTurns: number; maxTokens?: number; maxCost?: number; elapsedMs?: number };
export type StartRequest = { prompt: string; maxTurns?: number; evaluator?: boolean; role?: string; context?: ContextRequest; model?: string; thinking?: string; files?: string[];artifactId?:string };
export type PreparedRun = { budget: Budget;model?:string; createBackend(context?: ContextSnapshot): Promise<Backend> };
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };
const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 });
type Options = { createBackend(context?: ContextSnapshot): Promise<Backend>; prepare?(request: StartRequest): Promise<PreparedRun>; resolveSource?: (sessionId: string) => SessionManager | undefined; nextId(): string; concurrency?: number; pending?: number; slots?: number; bytes?: number; threads?: number; budget?: Budget; evaluatorSupported?: boolean; now?: () => number;cleanupMs?:number };
type Entry = { agentId: string; threadId: string; runId: string; prompt: string; state: RunState; backend?: Backend; stop: boolean; exhausted: boolean; turns: number;usage:Usage;usageKnown:boolean;toolUses:number; softNotified: boolean; budget?: Budget; seen: Set<string>; seenObjects: WeakSet<object>; timer?: ReturnType<typeof setTimeout>; result?: RunResult;artifacts?:RunResult["artifacts"]; consumed: boolean; text: string; truncated: boolean; resolve: (value: RunResult) => void; done: Promise<RunResult> };
type Thread = { agentId: string; id: string; state: "open" | "closing" | "closed"; current: Entry; runs: Entry[];model?:string; context?: ContextSnapshot; factory?: PreparedRun["createBackend"]; usage: Usage; turns: number; softNotified: boolean; deadline?: number; mailbox: string[]; mailboxBytes: number; backend?: Backend; executing: boolean; cleanup?: Promise<void> };
type Started = Receipt & { ok: true; agentId: string; threadId: string; runId: string };
type FleetEvent = { runId: string; threadId: string; type: "state" | "native" | "result"; state?: RunState; event?: any; result?: RunResult };
const failure = (code: Rejection["code"], domain?: Rejection["domain"]): Rejection => ({ ok: false, code, ...(domain ? { domain, recovery: domain === "results" ? "consume_or_close" : "retry_after_drain" } : {}) });
const receipt = (controlId: string, runId: string | undefined, error?: Rejection): Receipt => ({ version: 1, controlId, ...(runId ? { runId } : {}), status: error ? "rejected" : "handled", ...(error ? { error } : {}) });
const abortError = () => Object.assign(new Error("Wait cancelled"), { name: "AbortError" });

export function createSupervisor(options: Options) {
  const concurrency = options.concurrency ?? 3, pending = options.pending ?? limits.pendingRunsPerRoot;
  const slots = options.slots ?? limits.resultSlots, bytes = options.bytes ?? limits.queuedBytes;
  const threads = options.threads ?? limits.threadsPerRoot;
  const cleanupMs=options.cleanupMs??10000;
  if(!Number.isSafeInteger(cleanupMs)||cleanupMs<1||cleanupMs>30000)throw new RangeError("Invalid cleanup grace");
  if (![concurrency, pending, slots, bytes, threads].every(n => Number.isSafeInteger(n) && n > 0) ||
      concurrency > limits.resultSlots || pending > limits.pendingRunsPerRoot || slots > limits.resultSlots ||
      bytes > limits.queuedBytes || threads > limits.threadsPerRoot)
    throw new RangeError("Caps must be positive finite integers within contract limits");
  const budget = options.budget;
  const now = options.now ?? (() => performance.now());
  if (budget && (![budget.softTurns, budget.hardTurns].every(n => Number.isSafeInteger(n) && n > 0) || budget.hardTurns < budget.softTurns ||
      (budget.elapsedMs !== undefined && (!Number.isSafeInteger(budget.elapsedMs) || budget.elapsedMs < 0)) ||
      [budget.maxTokens, budget.maxCost].some(n => n !== undefined && (!Number.isFinite(n) || n <= 0)))) throw new RangeError("Invalid budget");
  const entries = new Map<string, Entry>(), byThread = new Map<string, Thread>();
  const ids = new Set<string>(), queue: Entry[] = [], listeners = new Set<(event: FleetEvent) => void>();
  let active = 0, queuedBytes = 0, disposed = false,disposing:Promise<void>|undefined;
  async function bounded<T>(operation:Promise<T>,expired:()=>void):Promise<T>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([operation,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{expired();reject(Error("Backend cleanup unconfirmed; owner quarantined"));},cleanupMs);})]);}
    finally{if(timer)clearTimeout(timer);}
  }
  const cleanup=(thread:Thread)=>bounded(thread.cleanup??=thread.backend!.dispose(),()=>state(thread.current,"quarantined"));
  function id(prefix: string) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const token = options.nextId();
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(token)) throw new Error("Invalid generated ID");
      const candidate = `${prefix}-${token}`;
      if (!ids.has(candidate)) { ids.add(candidate); return candidate; }
    }
    throw new Error("ID collision");
  }
  function emit(event: FleetEvent) { for (const listener of [...listeners]) { try { listener(event); } catch { /* observers cannot break workers */ } } }
  function state(entry: Entry, value: RunState) { entry.state = value; emit({ type: "state", state: value, runId: entry.runId, threadId: entry.threadId }); }
  function finish(entry: Entry, outcome: RunResult["outcome"], complete: boolean) {
    if (entry.result) return;
    if (entry.timer) clearTimeout(entry.timer);
    const metadataBytes=utf8Bytes(JSON.stringify({artifacts:entry.artifacts,usage:entry.usage}))+2048;
    const available=limits.resultBytesPerRun-metadataBytes;
    if(available<0){entry.artifacts=undefined;entry.truncated=true;complete=false;outcome="failed";}
    else if(utf8Bytes(entry.text)>available){let used=0,kept="";for(const point of entry.text){used+=utf8Bytes(point);if(used>available)break;kept+=point;}entry.text=kept;entry.truncated=true;}
    const result: RunResult = Object.freeze({ version: 1, agentId: entry.agentId, threadId: entry.threadId, runId: entry.runId,
      outcome, complete, truncated: entry.truncated, text: entry.text,turns:entry.turns,toolUses:entry.toolUses,...(entry.usageKnown?{usage:Object.freeze({...entry.usage})}:{}),...(entry.artifacts?.length?{artifacts:entry.artifacts}:{}) });
    entry.result = result; state(entry, "terminal"); entry.resolve(result);
    emit({ type: "result", runId: entry.runId, threadId: entry.threadId, result });
  }
  function reserved() { return [...entries.values()].filter(e => !e.consumed).length; }
  function prune() {
    // Consumed closed history is explicitly disposable; never evict an unconsumed outcome.
    for (const [threadId, thread] of byThread) if (thread.state === "closed" && thread.runs.every(e => e.consumed)) {
      byThread.delete(threadId);
      for (const e of thread.runs) entries.delete(e.runId);
    }
    while (entries.size > slots) {
      const old = [...entries.values()].find(e => e.consumed && e.result && byThread.get(e.threadId)?.current !== e);
      if (!old) break;
      entries.delete(old.runId);
      const thread = byThread.get(old.threadId);
      if (thread) thread.runs.splice(thread.runs.indexOf(old), 1);
    }
  }
  function makeEntry(agentId: string, threadId: string, runId: string, prompt: string, effective?: Budget): Entry {
    let resolve!: (value: RunResult) => void;
    const done = new Promise<RunResult>(r => { resolve = r; });
    return { agentId, threadId, runId, prompt, state: "queued", stop: false, exhausted: false, turns: 0,usage:emptyUsage(),usageKnown:false,toolUses:0, softNotified: false, budget: effective, seen: new Set(), seenObjects: new WeakSet(), consumed: false, text: "", truncated: false, resolve, done };
  }
  function exhaust(entry: Entry) {
    if (entry.result || entry.stop || entry.exhausted) return;
    entry.exhausted = true;
    if (entry.state === "queued") { cancelQueued(entry); return; }
    state(entry, "stopping");
    if (entry.backend) void entry.backend.abort().catch(() => {});
  }
  function observe(entry: Entry, event: any) {
    if (event?.type !== "message_end" || event.message?.role !== "assistant" || entry.exhausted || (event.runId !== undefined && event.runId !== entry.runId)) return;
    const m = event.message;
    if (typeof m.id === "string" && m.id.length) { if (entry.seen.has(m.id)) return; entry.seen.add(m.id); }
    else { if (entry.seenObjects.has(m)) return; entry.seenObjects.add(m); }
    entry.turns++;
    entry.toolUses+=(m.content??[]).filter((block:any)=>block.type==="toolCall").length;
    const thread = byThread.get(entry.threadId)!;
    thread.turns++;
    const u = m.usage, threshold = entry.budget?.maxTokens !== undefined || entry.budget?.maxCost !== undefined;
    if (threshold && (!u || ![u.input, u.output, u.cacheRead, u.cacheWrite, u.cost?.total].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0))) { exhaust(entry); return; }
    if (u && [u.input, u.output, u.cacheRead, u.cacheWrite, u.cost?.total].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) {
      entry.usageKnown=true;
      for(const key of ["input","output","cacheRead","cacheWrite"]as const)entry.usage[key]+=u[key];
      entry.usage.totalTokens+=u.input+u.output+u.cacheRead+u.cacheWrite;entry.usage.cost+=u.cost.total;
      const total = byThread.get(entry.threadId)!.usage;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) total[key] += u[key];
      total.totalTokens += u.input + u.output + u.cacheRead + u.cacheWrite;
      total.cost += u.cost.total;
    }
    const total = byThread.get(entry.threadId)!.usage;
    if ((entry.budget?.maxTokens !== undefined && total.totalTokens >= entry.budget.maxTokens) ||
        (entry.budget?.maxCost !== undefined && total.cost >= entry.budget.maxCost) ||
        (entry.budget && (thread.turns > entry.budget.hardTurns || (thread.turns === entry.budget.hardTurns && m.stopReason !== "stop")))) { exhaust(entry); return; }
    if (entry.budget && thread.turns >= entry.budget.softTurns && !thread.softNotified) {
      thread.softNotified = true;
      if (entry.backend?.steer) void entry.backend.steer("Please wrap up now; the turn budget is nearly exhausted.").catch(() => {});
    }
  }
  function enqueue(entry: Entry) { entries.set(entry.runId, entry); queue.push(entry); queuedBytes += utf8Bytes(entry.prompt); prune(); state(entry, "queued"); pump(); }
  function pump() {
    while (!disposed && active < concurrency) {
      const index = queue.findIndex(e => { const t = byThread.get(e.threadId)!; return t.state === "open" && !t.executing && t.current === e && !e.stop; });
      if (index < 0) break;
      const entry = queue.splice(index, 1)[0]; queuedBytes -= utf8Bytes(entry.prompt);
      active++; const thread = byThread.get(entry.threadId)!; thread.executing = true; state(entry, "initializing"); void execute(entry);
    }
  }
  async function execute(entry: Entry) {
    const thread = byThread.get(entry.threadId)!;
    try {
      const backend = thread.backend ?? await (thread.factory ?? options.createBackend)(thread.context); thread.backend = backend; entry.backend = backend;
      if (entry.stop || entry.exhausted || disposed || thread.state !== "open") finish(entry, entry.exhausted ? "budget_exhausted" : "interrupted", false);
      else {
        // A context-only mailbox is not a model turn and is delivered before prompting.
        if (thread.mailbox.length && !backend.message) throw new Error("Context-only delivery unsupported");
        for (const message of thread.mailbox.splice(0)) {
          if (entry.stop || entry.exhausted || disposed || thread.state !== "open") break;
          const delivery = await backend.message!(message);
          if (delivery.status === "rejected") throw new Error("Context-only delivery rejected");
        }
        thread.mailboxBytes = 0;
        if (entry.stop || entry.exhausted || disposed || thread.state !== "open") finish(entry, entry.exhausted ? "budget_exhausted" : "interrupted", false);
        else {
          state(entry, "running");
          if (entry.budget?.elapsedMs !== undefined) {
            thread.deadline ??= now() + entry.budget.elapsedMs;
            const remaining = thread.deadline - now();
            if (remaining <= 0) { exhaust(entry); finish(entry, "budget_exhausted", false); }
            else entry.timer = setTimeout(() => exhaust(entry), remaining);
          }
          if (entry.result) return;
          const result = await backend.run(entry.prompt, event => {
            if (entry.result || entry.stop || disposed) return;
            observe(entry, event);
            emit({ type: "native", runId: entry.runId, threadId: entry.threadId, event });
            if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
              const delta = event.assistantMessageEvent.delta;
              if (typeof delta === "string") {
                let chunk = "", used = utf8Bytes(entry.text);
                for (const point of delta) { const size = utf8Bytes(point); if (used + size > limits.resultBytesPerRun) break; chunk += point; used += size; }
                entry.text += chunk; if (chunk !== delta) entry.truncated = true;
              }
            }
          });
          if (result.outcome === "completed" && (entry.budget?.maxTokens !== undefined || entry.budget?.maxCost !== undefined) && entry.seen.size === 0 && entry.turns === 0) entry.exhausted = true;
          entry.artifacts=Object.freeze((await backend.artifacts?.()??[]).map(artifact=>Object.freeze({...artifact,files:Object.freeze([...artifact.files])})));
          finish(entry, entry.exhausted ? "budget_exhausted" : entry.stop || disposed ? "interrupted" : result.outcome, !entry.exhausted && !entry.stop && !disposed && result.complete && result.outcome === "completed");
        }
      }
    } catch { finish(entry, entry.exhausted ? "budget_exhausted" : entry.stop || disposed ? "interrupted" : "failed", false); }
    finally {
      if (thread.state === "closing" || entry.stop || entry.exhausted || disposed) {
        try { if (thread.backend) await cleanup(thread); thread.backend = undefined; }
        catch { state(entry, "quarantined"); return; }
      }
      if (entry.stop || entry.exhausted || !thread.backend) for (const next of thread.runs) if (next.state === "queued" && !next.result) cancelQueued(next);
      thread.executing = false; active--;
      if (thread.state === "closing") { thread.state = "closed"; prune(); }
      else { const next = thread.runs.find(e => e.state === "queued" && !e.result); if (next) thread.current = next; }
      pump();
    }
  }
  function capacity(prompt: string): Rejection | undefined {
    const size = utf8Bytes(prompt);
    if (size > bytes || queuedBytes + size > bytes) return failure("backpressure", "queued_bytes");
    if (queue.length >= pending) return failure("backpressure", "pending_runs");
    if (reserved() >= slots) return failure("backpressure", "results");
  }
  async function start(request: unknown): Promise<Started | Rejection> {
    if (disposed || !request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).some(k => !["prompt", "maxTurns", "evaluator", "role", "context", "model", "thinking", "files","artifactId"].includes(k)) || typeof (request as {prompt?: unknown}).prompt !== "string" || !(request as {prompt: string}).prompt.trim()) return failure("invalid_request");
    const { prompt, maxTurns, evaluator, role, context, model, thinking, files } = request as StartRequest;
    if((request as StartRequest).artifactId!==undefined&&(role!=="builder"||typeof(request as StartRequest).artifactId!=="string"||!/^[a-f0-9-]{36}$/.test((request as StartRequest).artifactId!)))return failure("invalid_request");
    if ((model !== undefined && (typeof model !== "string" || !/^[^\s/]+\/[^\s/]+$/.test(model))) ||
      (thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinking)) ||
      (files !== undefined && (!Array.isArray(files) || files.length > 64 || !files.every(f => typeof f === "string" && f.length > 0 && f.length <= 1024)))) return failure("invalid_request");
    if ((role !== undefined && (typeof role !== "string" || !role)) || (context !== undefined && (!role || !options.resolveSource))) return failure("invalid_request");
    const resolved = context && resolveContext(context, options.resolveSource!, role!);
    if (resolved && !resolved.ok) return failure(resolved.code);
    const snapshot = resolved?.ok ? resolved.snapshot : undefined;
    let prepared: PreparedRun | undefined;
    try { prepared = await options.prepare?.(Object.freeze({ ...(request as StartRequest), ...(files ? { files: [...files] } : {}) })); }
    catch { return failure("invalid_request"); }
    const budget = prepared?.budget ?? options.budget;
    if (prepared && (!budget || ![budget.softTurns, budget.hardTurns].every(n => Number.isSafeInteger(n) && n > 0) || budget.hardTurns < budget.softTurns ||
      (budget.elapsedMs !== undefined && (!Number.isSafeInteger(budget.elapsedMs) || budget.elapsedMs < 0)) ||
      [budget.maxTokens, budget.maxCost].some(n => n !== undefined && (!Number.isFinite(n) || n <= 0)) || typeof prepared.createBackend !== "function")) return failure("invalid_request");
    if (disposed) return failure("invalid_request");
    if (maxTurns !== undefined && (!budget || !Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > budget.softTurns)) return failure("invalid_request");
    if (evaluator !== undefined && (evaluator !== true || !options.evaluatorSupported || !budget || budget.softTurns < 2 || budget.hardTurns < 2)) return failure("unsupported_field");
    const effective = budget && (evaluator ? { ...budget, softTurns: 2, hardTurns: 2 } : { ...budget, softTurns: maxTurns ?? budget.softTurns, hardTurns: Math.min(budget.hardTurns, (maxTurns ?? budget.softTurns) + (budget.hardTurns - budget.softTurns)) });
    const cap = capacity(prompt); if (cap) return cap;
    if ([...byThread.values()].filter(t => t.state !== "closed").length >= threads) return failure("backpressure", "threads");
    // Generate all identities before mutating queue/threads; a failed generator cannot leak a reservation.
    const agentId = id("agent"), threadId = id("thread"), runId = id("run"), controlId = id("control");
    const entry = makeEntry(agentId, threadId, runId, prompt, effective);
    byThread.set(threadId, { agentId, id: threadId, state: "open", current: entry, runs: [entry],model:prepared?.model, context: snapshot, factory: prepared?.createBackend, usage: emptyUsage(), turns: 0, softNotified: false, mailbox: [], mailboxBytes: 0, executing: false });
    enqueue(entry);
    return { ok: true, version: 1, controlId, runId, threadId, agentId, status: "accepted" };
  }
  function cancelQueued(entry: Entry) { const i = queue.indexOf(entry); if (i >= 0) { queue.splice(i, 1); queuedBytes -= utf8Bytes(entry.prompt); } entry.stop = true; finish(entry, entry.exhausted ? "budget_exhausted" : "cancelled", false); }
  function stop(entry: Entry) {
    if (entry.result) return;
    if (entry.state === "queued") cancelQueued(entry);
    else { entry.stop = true; state(entry, "stopping"); if (entry.backend) void entry.backend.abort().catch(() => {}); }
  }
  async function control(request: Control): Promise<Receipt> {
    const thread = byThread.get(request?.threadId);
    const valid = validateControl(request, thread?.current.runId);
    // The caller-supplied control ID is validated but the supervisor always issues its own receipt ID.
    const controlId = id("control"), entry = thread?.current;
    if (!valid.ok) return receipt(controlId, entry?.runId, valid);
    if (!thread || !entry) return receipt(controlId, undefined, failure("stale_run"));
    const target = request.operation === "result" || request.operation === "consume"
      ? (request.expectedRunId ? entries.get(request.expectedRunId) : entry) : entry;
    if ((request.operation === "result" || request.operation === "consume") && target?.threadId !== thread.id)
      return receipt(controlId, entry.runId, failure("stale_run"));
    if (request.operation === "result") return { ...receipt(controlId, target!.runId, target!.result ? undefined : failure("invalid_request")), ...(target!.result ? { result: target!.result } : {}) };
    if (request.operation === "consume") {
      if (!target!.result) return receipt(controlId, target!.runId, failure("invalid_request"));
      target!.consumed = true; prune(); return receipt(controlId, target!.runId);
    }
    if (request.operation === "close") {
      if (thread.state === "closed") return receipt(controlId, entry.runId);
      if (thread.runs.some(e => e.state === "quarantined")) return receipt(controlId, entry.runId, failure("cleanup_unconfirmed"));
      thread.state = "closing"; thread.mailbox = []; thread.mailboxBytes = 0;
      for (const run of thread.runs) stop(run);
      if (!thread.executing && !thread.runs.some(e => e.state === "quarantined")) {
        try { if (thread.backend) await cleanup(thread); thread.backend = undefined; thread.state = "closed"; prune(); }
        catch { state(entry, "quarantined"); active++; return receipt(controlId, entry.runId, failure("cleanup_unconfirmed")); }
      }
      return receipt(controlId, entry.runId);
    }
    if (thread.state !== "open" || disposed) return receipt(controlId, entry.runId, failure("stale_run"));
    if (request.operation === "resume" && (!thread.backend || thread.executing || !entry.result?.complete || thread.backend.hasRetainedContext?.() !== true)) return receipt(controlId, entry.runId, failure("unsupported_field"));
    if (request.operation === "follow_up" || request.operation === "resume") {
      if (!thread.executing && !thread.backend) return receipt(controlId, entry.runId, failure("unsupported_field"));
      if (entry.exhausted || (thread.deadline !== undefined && now() >= thread.deadline) || (entry.budget && thread.turns >= entry.budget.hardTurns) || (entry.budget?.maxTokens !== undefined && thread.usage.totalTokens >= entry.budget.maxTokens) || (entry.budget?.maxCost !== undefined && thread.usage.cost >= entry.budget.maxCost)) return receipt(controlId, entry.runId, failure("backpressure"));
      const cap = capacity(request.message!); if (cap) return receipt(controlId, entry.runId, cap);
      if (thread.runs.filter(e => e.state === "queued" && !e.result).length >= limits.followUpsPerThread) return receipt(controlId, entry.runId, failure("backpressure", "follow_ups"));
      const runId = id("run"), next = makeEntry(thread.agentId, thread.id, runId, request.message!, entry.budget);
      thread.runs.push(next); if (entry.result && entry.state === "terminal") thread.current = next;
      enqueue(next);
      return { version: 1, controlId, runId, status: "queued" };
    }
    if (request.operation === "message") {
      const size = utf8Bytes(request.message!);
      if (thread.mailbox.length >= limits.mailboxPerThread || thread.mailboxBytes + size > limits.mailboxBytesPerThread) return receipt(controlId, entry.runId, failure("backpressure", "mailbox"));
      if (entry.state === "running" && entry.backend?.message) {
        try { const answer = await entry.backend.message(request.message!); return { version: 1, controlId, runId: entry.runId, status: answer.status }; }
        catch { return { version: 1, controlId, runId: entry.runId, status: "unknown_delivery" }; }
      }
      thread.mailbox.push(request.message!); thread.mailboxBytes += size;
      return { version: 1, controlId, runId: entry.runId, status: "queued" };
    }
    if (request.operation === "steer") {
      if (entry.state !== "running" || !entry.backend?.steer) return receipt(controlId, entry.runId, failure("unsupported_field"));
      try { const answer = await entry.backend.steer(request.message!); return { version: 1, controlId, runId: entry.runId, status: answer.status }; }
      catch { return { version: 1, controlId, runId: entry.runId, status: "unknown_delivery" }; }
    }
    if (request.operation !== "interrupt") return receipt(controlId, entry.runId, failure("unsupported_field"));
    if (entry.result) return receipt(controlId, entry.runId, failure("stale_run"));
    stop(entry); pump(); return receipt(controlId, entry.runId);
  }
  function inspect(threadId: string, runId?:string) {
    const thread = byThread.get(threadId); if (!thread) return;
    const entry = runId===undefined?thread.current:thread.runs.find(run=>run.runId===runId);
    if(!entry)return;
    const context = thread.context && Object.freeze({ sourceSessionId: thread.context.sourceSessionId, branchLeafId: thread.context.branchLeafId, entryAnchorId: thread.context.entryAnchorId, sourceEntryIds: thread.context.sourceEntryIds, serializedBytes: thread.context.serializedBytes, policy: thread.context.policy });
    return Object.freeze({ agentId: entry.agentId, threadId, runId: entry.runId,model:thread.model, state: entry.state, threadState: thread.state, context, turns: thread.turns,budget:entry.budget,runTurns:entry.turns,runUsage:Object.freeze({...entry.usage}),toolUses:entry.toolUses, usage: Object.freeze({ ...thread.usage }), consumed: entry.consumed, result: entry.result });
  }
  async function wait(runIds: readonly string[], signal?: AbortSignal, timeoutMs?: number): Promise<readonly RunResult[]> {
    const runs = runIds.map(runId => { const e = entries.get(runId); if (!e) throw new Error(`Unknown run: ${runId}`); return e.done; });
    if (signal?.aborted) throw abortError();
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)) throw new RangeError("Invalid wait timeout");
    if (!signal && timeoutMs === undefined) return Promise.all(runs);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined, settled = false;
      const clean = () => { signal?.removeEventListener("abort", onAbort); if (timer) clearTimeout(timer); };
      const fail = (error: Error) => { if (settled) return; settled = true; clean(); reject(error); };
      const onAbort = () => fail(abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(() => fail(Object.assign(new Error("Wait timed out"), { name: "TimeoutError" })), timeoutMs);
      void Promise.all(runs).then(value => { if (!settled) { settled = true; clean(); resolve(value); } }, fail);
      if (signal?.aborted) onAbort();
    });
  }
  function subscribe(listener: (event: FleetEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
  async function drain() {
    if (disposed && !active) return;
    disposed = true;
    for (const thread of byThread.values()) { if (thread.state !== "closed") thread.state = "closing"; thread.mailbox = []; thread.mailboxBytes = 0; }
    for (const entry of queue.splice(0)) cancelQueued(entry);
    queuedBytes = 0;
    for (const entry of entries.values()) if (!entry.result) stop(entry);
    for (const thread of byThread.values()) if (!thread.executing && thread.backend) {
      try { await cleanup(thread); thread.backend = undefined; thread.state = "closed"; }
      catch { state(thread.current, "quarantined"); throw new Error("Backend cleanup unconfirmed; admission slot quarantined"); }
    }
    await Promise.all([...entries.values()].map(e => e.done));
    while (active) {
      if ([...entries.values()].some(e => e.state === "quarantined")) throw new Error("Backend cleanup unconfirmed; admission slot quarantined");
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    listeners.clear();
  }
  function dispose(){return disposing??=bounded(drain(),()=>{for(const thread of byThread.values())if(thread.executing||thread.backend)state(thread.current,"quarantined");});}
  return { start, control, inspect, wait, subscribe, dispose };
}
