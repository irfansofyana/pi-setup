import assert from "node:assert/strict";
import test from "node:test";
import { HindsightHttpClient } from "./client.ts";

test("HindsightHttpClient applies request timeout while mocked I/O is pending", async () => {
  let requestSignal: AbortSignal | null | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    requestSignal = init?.signal;
    await new Promise<never>((_resolve, reject) => {
      // Real fetch owns live I/O. Model that liveness explicitly: AbortSignal.timeout
      // alone is unreferenced in Node, so a bare pending Promise can cancel this test.
      const watchdog = setTimeout(() => {
        requestSignal?.removeEventListener("abort", onAbort);
        reject(new Error("Request timeout did not abort mocked I/O"));
      }, 1000);
      const onAbort = () => {
        clearTimeout(watchdog);
        reject(requestSignal?.reason);
      };
      requestSignal?.addEventListener("abort", onAbort, { once: true });
    });
    return new Response("{}");
  };
  const client = new HindsightHttpClient({ apiUrl: "http://hindsight.invalid", autoStartDaemon: false, requestTimeoutMs: 10 }, fetchImpl);
  await assert.rejects(() => client.health(), { name: "TimeoutError" });
  assert.equal(requestSignal?.aborted, true);
});
