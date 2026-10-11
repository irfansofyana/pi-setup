import { lazyStream, type Provider } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { childRouting } from "../headroom/child-route.ts";

/** Delegate public provider/auth APIs only; never copy the parent's credential store. */
export function parentProvider(registry: ModelRegistry, assignment: string, options?: { routing: "headroom-preferred"; warn(message: string): void }): Provider {
  const slash = assignment.indexOf("/");
  const model = registry.find(assignment.slice(0, slash), assignment.slice(slash + 1));
  const original = model && registry.getProvider(model.provider);
  if (slash < 1 || !model || !original) throw Error("Exact parent model/provider unavailable");
  if (options?.routing === "headroom-preferred") return preferredProvider(registry, model, original, options.warn);
  const snapshot = { ...model };
  let authorizedBaseUrl = snapshot.baseUrl;
  const matches = (candidate: any) => candidate && candidate.provider === snapshot.provider && candidate.id === snapshot.id && candidate.api === snapshot.api && candidate.baseUrl === snapshot.baseUrl;
  const resolve = async () => {
    if (!matches(registry.find(snapshot.provider, snapshot.id))) return undefined;
    const result = await registry.getApiKeyAndHeaders(snapshot);
    if (result.ok) authorizedBaseUrl = result.baseUrl ?? snapshot.baseUrl;
    return result.ok ? { auth: { apiKey: result.apiKey, headers: result.headers, baseUrl: result.baseUrl }, env: result.env, source: "parent registry" } : undefined;
  };
  const assert = (candidate: any) => { if (!candidate || candidate.provider !== snapshot.provider || candidate.id !== snapshot.id || candidate.api !== snapshot.api ||
    ![snapshot.baseUrl,authorizedBaseUrl].includes(candidate.baseUrl) || !matches(registry.find(snapshot.provider, snapshot.id))) throw Error("Child model assignment changed"); };
  return { id: original.id, name: original.name, baseUrl: original.baseUrl,
    getModels: () => [snapshot],
    auth: { apiKey: { name: "Parent registry", resolve, check: async () => await resolve() ? { type: "api_key", source: "parent registry" } : undefined } },
    stream: (model, context, options) => { assert(model); return original.stream.call(original, model, context, options); },
    streamSimple: (model, context, options) => { assert(model); return original.streamSimple.call(original, model, context, options); },
  } as Provider;
}

function preferredProvider(registry: ModelRegistry, model: any, original: Provider, warn: (message: string) => void): Provider {
  const canonical = childRouting(registry)?.canonical(model.provider, model.id);
  const snapshot = { ...model, ...(canonical ?? {}) };
  let authorizedBaseUrl = snapshot.baseUrl, directWarning = false;
  const matches = (candidate: any) => candidate && candidate.provider === snapshot.provider && candidate.id === snapshot.id && candidate.api === snapshot.api;
  const resolve = async () => {
    const current = registry.find(snapshot.provider, snapshot.id);
    const known = childRouting(registry)?.canonical(snapshot.provider, snapshot.id);
    if (!matches(current) || (known ? !matches(known) || known.baseUrl !== snapshot.baseUrl : current!.baseUrl !== snapshot.baseUrl)) return undefined;
    const result = await registry.getApiKeyAndHeaders(snapshot);
    if (!result.ok) return undefined;
    // Registry provider routing is not an OAuth-discovered upstream override.
    authorizedBaseUrl = result.baseUrl && result.baseUrl !== current!.baseUrl ? result.baseUrl : snapshot.baseUrl;
    return { auth: { apiKey: result.apiKey, headers: result.headers, baseUrl: authorizedBaseUrl }, env: result.env, source: "parent registry" };
  };
  const dispatch = (simple: boolean, candidate: any, context: any, streamOptions: any = {}) => lazyStream(snapshot, async () => {
    if (!matches(candidate) || ![snapshot.baseUrl, authorizedBaseUrl].includes(candidate.baseUrl)) throw Error("Child model assignment changed");
    const signal: AbortSignal | undefined = streamOptions.signal;
    signal?.throwIfAborted();
    const auth = await resolve();
    if (!auth) throw Error("Exact parent authentication or model unavailable");
    let route: Awaited<ReturnType<NonNullable<ReturnType<typeof childRouting>>["route"]>>;
    const routing = childRouting(registry);
    if (routing) {
      const deadline = AbortSignal.timeout(2000);
      const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
      let listener: (() => void) | undefined;
      try {
        route = await Promise.race([routing.route(snapshot.provider, snapshot.id, bounded), new Promise<never>((_resolve, reject) => {
          listener = () => reject(bounded.reason); bounded.addEventListener("abort", listener, { once: true });
          if (bounded.aborted) listener();
        })]);
      } catch { signal?.throwIfAborted(); }
      finally { if (listener) bounded.removeEventListener("abort", listener); }
    }
    signal?.throwIfAborted();
    if (!route && !directWarning) { directWarning = true; try { warn(`Headroom unavailable for ${snapshot.provider}/${snapshot.id}; using direct upstream provider (compression bypassed).`); } catch {} }
    if (route) directWarning = false;
    const headers = Object.fromEntries(Object.entries({ ...streamOptions.headers, ...auth.auth.headers }).filter(([key]) => key.toLowerCase() !== "x-headroom-base-url"));
    if (route) headers["x-headroom-base-url"] = auth.auth.baseUrl !== snapshot.baseUrl ? auth.auth.baseUrl.replace(/\/v1\/?$/, "") : route.upstream ?? snapshot.baseUrl.replace(/\/v1\/?$/, "");
    const target = { ...snapshot, baseUrl: route?.baseUrl ?? auth.auth.baseUrl };
    const transport = route && snapshot.api === "openai-codex-responses" ? { transport: "sse" } : {};
    // No retry: once handed to the provider, failures belong to that exact request.
    return (simple ? original.streamSimple : original.stream).call(original, target, context,
      { ...streamOptions, apiKey: auth.auth.apiKey, headers, ...transport });
  });
  return { id: original.id, name: original.name, baseUrl: snapshot.baseUrl, getModels: () => [snapshot],
    auth: { apiKey: { name: "Parent registry", resolve, check: async () => await resolve() ? { type: "api_key", source: "parent registry" } : undefined } },
    stream: (candidate, context, streamOptions) => dispatch(false, candidate, context, streamOptions),
    streamSimple: (candidate, context, streamOptions) => dispatch(true, candidate, context, streamOptions),
  } as Provider;
}
