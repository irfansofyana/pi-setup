import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installGuardedHeadroomRoute } from "./route-transport.ts";

const credentials = { read: async () => undefined, list: async () => [], modify: async (_id: string, fn: (value: undefined) => unknown) => fn(undefined), delete: async () => {} };
const createRuntime = () => ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false, credentials: credentials as any });
const context = { messages: [{ role: "user", content: "test", timestamp: 0 }] } as any;

test("guarded route dispatches through a local proxy, then refuses an unready or released lease without direct upstream", async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.url === "/readyz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ready: true }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_local","status":"in_progress","model":"gpt-4","output":[],"usage":null}}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_local","output_index":0,"content_index":0,"delta":"offline"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_local","status":"completed","model":"gpt-4","output":[{"id":"msg_local","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"offline","annotations":[]}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const proxy = `http://127.0.0.1:${address.port}/v1`;
    const runtime = await createRuntime();
    await runtime.setRuntimeApiKey("openai", "offline-fixture-not-a-secret");
    let ready = true;
    const lease = { ready: async () => ready, release: async () => { ready = false; } };
    assert.equal(installGuardedHeadroomRoute({ runtime, model: "openai/gpt-4", proxyBaseUrl: proxy, lease }), true);
    const model = runtime.getModel("openai", "gpt-4")!;
    assert.equal(model.baseUrl, proxy);
    const originalFetch = globalThis.fetch;
    const attempted: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      attempted.push(url);
      if (!url.startsWith(proxy)) throw new Error(`direct upstream attempted: ${url}`);
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const response = await runtime.streamSimple(model, context, { maxTokens: 16 }).result();
      assert.equal(response.stopReason, "stop", JSON.stringify(response));
      assert.equal(requests.length, 1);
      ready = false;
      const unready = await runtime.streamSimple(model, context, { maxTokens: 16 }).result();
      assert.notEqual(unready.stopReason, "stop");
      assert.equal(requests.length, 1);
      await lease.release();
      const released = await runtime.streamSimple(model, context, { maxTokens: 16 }).result();
      assert.notEqual(released.stopReason, "stop");
      assert.equal(requests.length, 1);
      assert.equal(attempted.every(url => url.startsWith(proxy)), true);
    } finally { globalThis.fetch = originalFetch; }
  } finally { server.close(); }
});

test("a killed local proxy prevents any post-loss model request, including when child model stays routed", async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => { requests.push(req.url ?? ""); res.writeHead(200, { "content-type": "application/json" }); res.end('{"service":"headroom-proxy","ready":true,"checks":{"upstream":{"ready":true}}}'); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  const runtime = await createRuntime(); await runtime.setRuntimeApiKey("openai", "offline-fixture-not-a-secret");
  const lease = { ready: async () => fetch(`${proxyUrl}/readyz`, { signal: AbortSignal.timeout(500) }).then(response => response.ok).catch(() => false), release: async () => {} };
  assert.equal(installGuardedHeadroomRoute({ runtime, model: "openai/gpt-4", proxyBaseUrl: `${proxyUrl}/v1`, lease }), true);
  const model = runtime.getModel("openai", "gpt-4")!;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const originalFetch = globalThis.fetch;
  const destinations: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    destinations.push(url);
    if (!url.startsWith(proxyUrl)) throw new Error(`direct upstream attempted: ${url}`);
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    const result = await runtime.streamSimple(model, context, { maxTokens: 16 }).result();
    assert.notEqual(result.stopReason, "stop");
    assert.deepEqual(requests, []);
    assert.deepEqual(destinations, [`${proxyUrl}/readyz`]);
  } finally { globalThis.fetch = originalFetch; }
});

test("route installation rejects unsupported provider, wrong model, and non-loopback destination before registration", async () => {
  const runtime = await createRuntime();
  const lease = { ready: async () => true, release: async () => {} };
  for (const [model, url] of [["openai/unknown", "http://127.0.0.1:8765/v1"], ["openai/gpt-4", "https://api.openai.com/v1"], ["google/gemini-2.5-pro", "http://127.0.0.1:8765/v1"]]) {
    assert.equal(installGuardedHeadroomRoute({ runtime, model, proxyBaseUrl: url, lease }), false);
  }
  assert.deepEqual(runtime.getRegisteredProviderIds(), []);
});
