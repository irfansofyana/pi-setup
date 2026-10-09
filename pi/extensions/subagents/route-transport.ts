// M1 transport probe: not activated or bound to a canonical role.
// The lease is acquired only through Headroom's version-checked 1.1.0 bridge.
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { HeadroomChildLease } from "../headroom/index.ts";
import { isLocalProxyUrl, proxyBaseUrlForApi } from "../headroom/index.ts";

/** Install a request-dispatch guard on an isolated child runtime, not an extension event hook. */
export function installGuardedHeadroomRoute(options: {
  runtime: ModelRuntime; model: string; proxyBaseUrl: string; lease: HeadroomChildLease;
}): boolean {
  const { runtime, model, proxyBaseUrl, lease } = options;
  const slash = model.indexOf("/");
  const providerId = model.slice(0, slash), modelId = model.slice(slash + 1);
  if (slash < 1 || !modelId || !["openai", "anthropic", "openai-codex"].includes(providerId) ||
    runtime.getRegisteredProviderIds().includes(providerId) || !isLocalProxyUrl(proxyBaseUrl)) return false;
  const native = runtime.getProvider(providerId);
  const canonical = runtime.getModel(providerId, modelId);
  if (!native || !canonical || canonical.baseUrl !== native.baseUrl ||
    proxyBaseUrlForApi(new URL(proxyBaseUrl).origin, canonical.api) !== proxyBaseUrl) return false;
  try {
    runtime.registerProvider(providerId, {
      api: canonical.api, baseUrl: proxyBaseUrl,
      streamSimple: (requestModel, context, requestOptions) => lazyStream(requestModel, async () => {
        const actual = runtime.getModel(providerId, modelId);
        if (requestModel.provider !== providerId || requestModel.id !== modelId ||
          requestModel.api !== canonical.api || requestModel.baseUrl !== proxyBaseUrl ||
          actual?.baseUrl !== proxyBaseUrl ||
          runtime.getRegisteredProviderConfig(providerId)?.baseUrl !== proxyBaseUrl ||
          requestOptions?.signal?.aborted || !(await lease.ready())) {
          throw new Error("Headroom child route unavailable; direct provider dispatch forbidden");
        }
        // A pinned model bypasses any later native model-registry fallback. This
        // delegate is the pre-registration built-in provider, not an extension hook.
        return native.streamSimple({ ...requestModel, baseUrl: proxyBaseUrl }, context, requestOptions);
      }),
    });
    return runtime.getModel(providerId, modelId)?.baseUrl === proxyBaseUrl;
  } catch { return false; }
}
