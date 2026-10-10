import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import headroom, { DEFAULT_CONFIG } from "../headroom/index.ts";
import { createTrustedRoleBackend } from "./trusted.ts";

// Missing lease retention, a native-provider fallback, or ignoring the installed
// role's model pin must break these real SDK/loopback integration checks.
async function fixture(run: (value: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "routed-role-"));
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  const requests: { path: string; auth?: string; body: string }[] = [];
  let ready = true;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url!, auth: req.headers.authorization, body });
    if (req.url === "/readyz") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ service: "headroom-proxy", ready, checks: { upstream: { ready } } }));
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    res.end('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_local","status":"in_progress","model":"gpt-4","output":[],"usage":null}}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_local","output_index":0,"content_index":0,"delta":"offline"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_local","status":"completed","model":"gpt-4","output":[{"id":"msg_local","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"offline","annotations":[]}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n');
  });
  const handlers: Record<string, (...args: any[]) => any> = {};
  let stop = async () => {};
  const originalFetch = globalThis.fetch;
  try {
    await mkdir(join(agentDir, "agents"), { recursive: true }); await mkdir(cwd);
    await writeFile(join(agentDir, "agents", "researcher.md"), await readFile(new URL("../../agents/researcher.md", import.meta.url), "utf8"));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const proxyUrl = `http://127.0.0.1:${address.port}`;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== proxyUrl) throw Error("test forbids non-fixture network");
      return originalFetch(input, init);
    }) as typeof fetch;
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
      credentials: { read: async () => undefined, list: async () => [], modify: async (_id, fn) => fn(undefined), delete: async () => {} } });
    await runtime.setRuntimeApiKey("openai", "parent-fixture-not-a-secret");
    const registry = new ModelRegistry(runtime);
    const ctx = { cwd, hasUI: false, modelRegistry: registry, ui: { notify() {}, setStatus() {} } };
    headroom({ registerProvider: (id: string, config: any) => runtime.registerProvider(id, config), unregisterProvider: (id: string) => runtime.unregisterProvider(id),
      on: (name: string, handler: any) => { handlers[name] = handler; }, registerTool() {}, registerCommand() {}, getSessionName() {} } as any,
    { readConfig: () => ({ ...DEFAULT_CONFIG, proxyUrl, startup: "auto", localToolResultCompression: false }), health: async () => true,
      proxyHistory: async () => ({ displaySession: { requests: 0, tokens_saved: 0, total_input_tokens: 0 } }), ensureDirs() {}, cleanupStore() {}, configuredProviderIds: () => new Set() } as any);
    stop = async () => { await handlers.session_shutdown({}, ctx); };
    await handlers.session_start({}, ctx);
    const options = { role: "researcher", agentDir, cwd, model: "openai/gpt-4", reviewedHeadroom: { enabled: true },
      headroom: { registry, proxyUrl, apiKey: "offline-fixture-not-a-secret" },
      available: { models: ["openai/gpt-4", "openai/gpt-4o-mini"], tools: ["ext:web-research/web_search", "ext:web-research/web_fetch"], extensions: ["web-research", "headroom"], skills: ["my-web-search"] } };
    await run({ options, registry, requests, stop, setReady: (value: boolean) => { ready = value; } });
  } finally {
    await stop(); globalThis.fetch = originalFetch;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

test("canonical routed Ciung retains a real parent lease, pins role model/auth, and releases after disposal", async () => fixture(async ({ options, registry, requests, stop }) => {
  const rolePath = join(options.agentDir, "agents", "researcher.md");
  await writeFile(rolePath, (await readFile(rolePath, "utf8")).replace("thinking: medium", "model: openai/gpt-4\nthinking: medium"));
  const result = await createTrustedRoleBackend({ ...options, model: "openai/gpt-4o-mini" });
  assert.equal(result.ok, true, result.ok ? undefined : result.code);
  if (!result.ok) return;
  try {
    assert.deepEqual(result.backend.activeTools.sort(), ["web_fetch", "web_search"]);
    await stop(); // The child lease must outlive the parent's extension activation.
    assert.match(registry.find("openai", "gpt-4")!.baseUrl, /^http:\/\/127\.0\.0\.1:/);
    const events: any[] = [];
    assert.deepEqual(await result.backend.run("Summarize a public topic", event => events.push(event)), { outcome: "completed", complete: true });
    assert.equal(events.filter(e => e.type === "agent_settled").length, 1);
    const transport = requests.filter((r: any) => r.path !== "/readyz");
    assert.equal(transport.length, 1);
    assert.equal(transport[0].path, "/v1/responses");
    assert.equal(transport[0].auth, "Bearer offline-fixture-not-a-secret");
    const payload = JSON.parse(transport[0].body);
    assert.equal(payload.model, "gpt-4");
    assert.match(transport[0].body, /You are Ciung/); assert.match(transport[0].body, /my-web-search/);
    assert.deepEqual((await readdir(options.agentDir)).sort(), ["agents"]);
    assert.deepEqual(await readdir(options.cwd), []);
  } finally { await result.backend.dispose(); await result.backend.dispose(); }
  assert.equal(registry.find("openai", "gpt-4")!.baseUrl, "https://api.openai.com/v1");
}));

test("routed child refuses requests after proxy readiness loss and does not fall back upstream", async () => fixture(async ({ options, requests, setReady }) => {
  const result = await createTrustedRoleBackend(options);
  assert.equal(result.ok, true, result.ok ? undefined : result.code);
  if (!result.ok) return;
  try {
    setReady(false);
    const outcome = await result.backend.run("Public question", () => {});
    assert.equal(outcome.outcome, "failed"); assert.equal(outcome.complete, false);
    assert.equal(requests.filter((r: any) => r.path !== "/readyz").length, 0);
  } finally { await result.backend.dispose(); }
}));

test("missing route credentials and conflicting native mode reject without borrowing a parent lease", async () => fixture(async ({ options, requests }) => {
  for (const change of [{ headroom: { ...options.headroom, apiKey: "" } }, { routing: "native" }, { headroom: undefined }]) {
    assert.deepEqual(await createTrustedRoleBackend({ ...options, ...change }), { ok: false, code: "unsupported_routing" });
  }
  assert.deepEqual(requests, []);
}));
