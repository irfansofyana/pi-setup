import type { Provider } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** Delegate public provider/auth APIs only; never copy the parent's credential store. */
export function parentProvider(registry: ModelRegistry, assignment: string): Provider {
  const slash = assignment.indexOf("/");
  const model = registry.find(assignment.slice(0, slash), assignment.slice(slash + 1));
  const original = model && registry.getProvider(model.provider);
  if (slash < 1 || !model || !original) throw Error("Exact parent model/provider unavailable");
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
