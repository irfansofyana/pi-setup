// M1 feasibility boundary. This adapter is NOT activated by index.ts.
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import type { ContextSnapshot } from "./context.ts";
import { limits, utf8Bytes } from "./contracts.ts";

export type BackendError = "unsupported_provider" | "unsupported_resource" | "unsupported_routing" | "initialization_failed";
export type BackendResult = { ok: false; code: BackendError } | { ok: true; backend: NativeBackend };
export type BackendOptions = {
  agentDir: string; cwd: string; model: string;
  /** Explicitly reviewed provider instance; never implicitly borrowed from the parent. */
  provider: Provider;
  context?: ContextSnapshot;
  tools?: readonly string[]; extensions?: readonly string[];
};
export type ControlReceipt = { status: "queued" | "handled" | "unknown_delivery" } | { status: "rejected"; code: "not_running" | "disposed" | "unsupported_operation" };

/** Only a single read-only built-in tool is approved for this offline feasibility spike. */
export async function createNativeBackend(options: BackendOptions): Promise<BackendResult> {
  if (options.model !== `${options.provider.id}/offline` || options.provider.id !== "offline-fixture") return { ok: false, code: "unsupported_provider" };
  if (options.extensions?.length || (options.tools && (options.tools.length !== 1 || options.tools[0] !== "read"))) return { ok: false, code: "unsupported_resource" };
  if (options.context && (options.context.serializedBytes !== utf8Bytes(JSON.stringify({ sourceSessionId: options.context.sourceSessionId, branchLeafId: options.context.branchLeafId, entryAnchorId: options.context.entryAnchorId, sourceEntryIds: options.context.sourceEntryIds, messages: options.context.messages, policy: options.context.policy })) || options.context.serializedBytes > limits.contextBytes || !options.context.messages.length)) return { ok: false, code: "unsupported_resource" };
  const settingsManager = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({ cwd: options.cwd, agentDir: options.agentDir, settingsManager,
    noExtensions: true, disabledBuiltinExtensions: ["mcp", "codemode", "tool-search"], noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true });
  try {
    await loader.reload();
    if (loader.getExtensions().extensions.length || loader.getSkills().skills.length) return { ok: false, code: "unsupported_resource" };
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
      credentials: { read: async () => undefined, list: async () => [], modify: async (_id, fn) => fn(undefined), delete: async () => {} } });
    modelRuntime.registerNativeProvider(options.provider);
    const model = modelRuntime.getModel(options.provider.id, "offline");
    if (!model || !(await modelRuntime.checkAuth(options.provider.id))) return { ok: false, code: "unsupported_provider" };
    const sessionManager = SessionManager.inMemory(options.cwd);
    for (const message of options.context?.messages ?? []) sessionManager.appendMessage(structuredClone(message));
    const { session } = await createAgentSession({ cwd: options.cwd, agentDir: options.agentDir,
      modelRuntime, model, resourceLoader: loader, settingsManager, sessionManager,
      tools: ["read"], thinkingLevel: "off" });
    await session.bindExtensions({});
    if (session.getActiveToolNames().join() !== "read" || session.getCallableToolNames().join() !== "read") {
      session.dispose();
      return { ok: false, code: "unsupported_resource" };
    }
    return { ok: true, backend: new NativeBackend(session) };
  } catch {
    // Never infer a fallback model/provider on SDK initialization failure.
    return { ok: false, code: "initialization_failed" };
  }
}

export class NativeBackend {
  private running = false;
  private interrupted = false;
  private disposed = false;
  private settled = false;
  private readonly session: AgentSession;
  constructor(session: AgentSession) { this.session = session; }
  get activeTools(): string[] { return this.session.getActiveToolNames(); }
  get isStreaming(): boolean { return this.session.isStreaming; }
  hasRetainedContext(): boolean { return !this.disposed && this.session.sessionManager.buildSessionContext().messages.length > 0; }
  async run(prompt: string, emit: (event: AgentSessionEvent) => void): Promise<{ outcome: "completed" | "failed" | "interrupted"; complete: boolean }> {
    if (this.disposed || this.running) return { outcome: "failed", complete: false };
    this.running = true; this.interrupted = false; this.settled = false;
    const unsubscribe = this.session.subscribe(event => {
      if (event.type === "agent_settled") {
        if (this.settled) return;
        this.settled = true;
      }
      emit(event);
    });
    try {
      await this.session.prompt(prompt, { expandPromptTemplates: false, source: "rpc" });
      await this.session.waitForIdle();
      if (!this.settled) return { outcome: "failed", complete: false };
      const last = this.session.messages.filter(m => m.role === "assistant").at(-1);
      if (this.interrupted) return { outcome: "interrupted", complete: false };
      if (!last || last.stopReason !== "stop") return { outcome: "failed", complete: false };
      return { outcome: "completed", complete: true };
    } catch {
      return { outcome: this.interrupted ? "interrupted" : "failed", complete: false };
    } finally { unsubscribe(); this.running = false; }
  }
  async control(_request: { operation: string; message?: string }): Promise<ControlReceipt> {
    return { status: "rejected", code: "unsupported_operation" };
  }
  async message(text: string): Promise<ControlReceipt> {
    if (this.disposed) return { status: "rejected", code: "disposed" };
    await this.session.sendCustomMessage({ customType: "subagents-context", content: text, display: false }, { triggerTurn: false, deliverAs: "nextTurn" });
    // The SDK does not acknowledge model consumption; do not advertise applied delivery.
    return { status: "unknown_delivery" };
  }
  async steer(text: string): Promise<ControlReceipt> {
    if (this.disposed) return { status: "rejected", code: "disposed" };
    if (!this.running) return { status: "rejected", code: "not_running" };
    const disposition = await this.session.steer(text, undefined, { source: "rpc" });
    return { status: disposition };
  }
  async abort(): Promise<void> {
    if (!this.running || this.disposed) return;
    this.interrupted = true;
    this.session.clearQueue();
    await this.session.abort();
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.running) await this.abort();
    this.session.clearQueue();
    this.session.dispose();
    this.disposed = true;
  }
}
