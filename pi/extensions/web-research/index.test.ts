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
    { query: "versioned API option", maxResults: 3, profile: "balanced" },
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
