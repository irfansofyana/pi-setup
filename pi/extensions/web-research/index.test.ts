import assert from "node:assert/strict";
import test from "node:test";
import webResearch from "./index.ts";

function harness(fetchImpl: typeof fetch, env: Record<string, string | undefined> = {}) {
  const tools = new Map<string, any>();
  webResearch({ registerTool(tool: any) { tools.set(tool.name, tool); } } as any, {
    fetch: fetchImpl,
    env,
    now: () => 1_725_000_000_000,
  });
  return tools;
}

test("web_search uses Tavily by default and returns compact normalized evidence", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const tools = harness(async (input, init = {}) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({
      request_id: "tavily-request-1",
      response_time: 0.42,
      results: [
        {
          title: "Versioned API reference",
          url: "https://docs.example.test/v1/reference",
          content: "Exact query-relevant excerpt.",
          score: 0.91,
          published_date: "2026-08-01",
          raw_content: "must not enter compact search output",
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, { TAVILY_API_KEY: "test-tavily" });

  assert.deepEqual([...tools.keys()], ["web_search"]);
  const tool = tools.get("web_search");
  assert.deepEqual(tool.parameters.required, ["query"]);
  assert.equal(tool.executionMode, "parallel");

  const updates: unknown[] = [];
  const result = await tool.execute(
    "call-1",
    {
      query: "versioned API option",
      maxResults: 3,
      profile: "balanced",
      includeDomains: ["docs.example.test"],
      excludeDomains: ["archive.example.test"],
      publishedAfter: "2026-07-01",
      publishedBefore: "2026-08-30",
    },
    new AbortController().signal,
    (update: unknown) => updates.push(update),
    { cwd: "/tmp/project" },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://api.tavily.com/search");
  assert.equal(new Headers(requests[0]?.init.headers).get("authorization"), "Bearer test-tavily");
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    query: "versioned API option",
    max_results: 3,
    search_depth: "basic",
    include_raw_content: false,
    include_domains: ["docs.example.test"],
    exclude_domains: ["archive.example.test"],
    start_date: "2026-07-01",
    end_date: "2026-08-30",
  });

  const text = result.content[0]?.text ?? "";
  assert.match(text, /Versioned API reference/);
  assert.match(text, /https:\/\/docs\.example\.test\/v1\/reference/);
  assert.match(text, /Exact query-relevant excerpt\./);
  assert.doesNotMatch(text, /must not enter compact search output/);
  assert.deepEqual(result.details, {
    provider: "tavily",
    resolvedMode: "basic",
    attempts: [{ provider: "tavily", outcome: "success", status: 200 }],
    resultCount: 1,
    requestId: "tavily-request-1",
    durationMs: 0,
    cacheHit: false,
    truncated: false,
  });
  assert.ok(updates.length >= 1);
});

test("web_search routes declared semantic intent to Exa and preserves exact highlights", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const tools = harness(async (input, init = {}) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({
      requestId: "exa-request-1",
      results: [{
        title: "Semantic source",
        url: "https://research.example.test/paper",
        publishedDate: "2026-07-01T00:00:00.000Z",
        author: "Researcher",
        highlights: ["Exact semantic highlight."],
        highlightScores: [0.87],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, { TAVILY_API_KEY: "test-tavily", EXA_API_KEY: "test-exa" });

  const result = await tools.get("web_search").execute(
    "call-exa",
    { query: "conceptual architecture pattern", intent: "semantic", profile: "balanced" },
    new AbortController().signal,
    undefined,
    { cwd: "/tmp/project" },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://api.exa.ai/search");
  assert.equal(new Headers(requests[0]?.init.headers).get("x-api-key"), "test-exa");
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    query: "conceptual architecture pattern",
    numResults: 5,
    type: "auto",
    contents: { highlights: { maxCharacters: 2_000 } },
  });
  assert.match(result.content[0]?.text ?? "", /Exact semantic highlight\./);
  assert.deepEqual(result.details, {
    provider: "exa",
    resolvedMode: "auto",
    attempts: [{ provider: "exa", outcome: "success", status: 200 }],
    resultCount: 1,
    requestId: "exa-request-1",
    durationMs: 0,
    cacheHit: false,
    truncated: false,
  });
});

test("web_search falls back from an empty Tavily response to Exa and reports both attempts", async () => {
  const requests: string[] = [];
  const tools = harness(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("tavily")) {
      return new Response(JSON.stringify({ request_id: "t-empty", results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      requestId: "e-fallback",
      results: [{ title: "Fallback source", url: "https://example.test/fallback", highlights: ["Fallback evidence."] }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, { TAVILY_API_KEY: "test-tavily", EXA_API_KEY: "test-exa" });

  const result = await tools.get("web_search").execute(
    "call-fallback",
    { query: "ordinary current fact" },
    new AbortController().signal,
    undefined,
    { cwd: "/tmp/project" },
  );

  assert.deepEqual(requests, ["https://api.tavily.com/search", "https://api.exa.ai/search"]);
  assert.equal(result.details.provider, "exa");
  assert.deepEqual(result.details.attempts, [
    { provider: "tavily", outcome: "empty", status: 200 },
    { provider: "exa", outcome: "success", status: 200 },
  ]);
});

test("web_search never falls back to Exa after a Tavily authentication failure", async () => {
  const requests: string[] = [];
  const tools = harness(async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ detail: "do not leak this upstream payload" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }, { TAVILY_API_KEY: "test-tavily", EXA_API_KEY: "test-exa" });

  await assert.rejects(
    tools.get("web_search").execute(
      "call-auth",
      { query: "ordinary current fact" },
      new AbortController().signal,
      undefined,
      { cwd: "/tmp/project" },
    ),
    (error: unknown) => {
      assert.match(String(error), /Tavily authentication failed/i);
      assert.doesNotMatch(String(error), /do not leak this upstream payload/);
      assert.doesNotMatch(String(error), /test-tavily|test-exa/);
      return true;
    },
  );
  assert.deepEqual(requests, ["https://api.tavily.com/search"]);
});

test("web_search honors an explicit Exa override and maps portable filters", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const tools = harness(async (_input, init = {}) => {
    requestBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ requestId: "explicit-exa", results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, { TAVILY_API_KEY: "test-tavily", EXA_API_KEY: "test-exa" });

  const result = await tools.get("web_search").execute(
    "call-explicit",
    {
      query: "release notes",
      provider: "exa",
      intent: "general",
      includeDomains: ["github.com"],
      excludeDomains: ["gist.github.com"],
      publishedAfter: "2026-01-01T00:00:00.000Z",
      publishedBefore: "2026-08-30T23:59:59.000Z",
    },
    new AbortController().signal,
    undefined,
    { cwd: "/tmp/project" },
  );

  assert.equal(result.details.provider, "exa");
  assert.deepEqual(requestBody, {
    query: "release notes",
    numResults: 5,
    type: "auto",
    contents: { highlights: { maxCharacters: 2_000 } },
    includeDomains: ["github.com"],
    excludeDomains: ["gist.github.com"],
    startPublishedDate: "2026-01-01T00:00:00.000Z",
    endPublishedDate: "2026-08-30T23:59:59.000Z",
  });
});

test("web_search falls back after a retryable Tavily upstream failure", async () => {
  const requests: string[] = [];
  const tools = harness(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("tavily")) return new Response("temporary", { status: 503 });
    return new Response(JSON.stringify({ requestId: "exa-after-503", results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, { TAVILY_API_KEY: "test-tavily", EXA_API_KEY: "test-exa" });

  const result = await tools.get("web_search").execute(
    "call-transient",
    { query: "ordinary current fact" },
    new AbortController().signal,
    undefined,
    { cwd: "/tmp/project" },
  );

  assert.deepEqual(requests, ["https://api.tavily.com/search", "https://api.exa.ai/search"]);
  assert.deepEqual(result.details.attempts, [
    { provider: "tavily", outcome: "error", status: 503, errorKind: "upstream" },
    { provider: "exa", outcome: "empty", status: 200 },
  ]);
});
