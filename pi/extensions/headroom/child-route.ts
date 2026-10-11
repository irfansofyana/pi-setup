/** Registry-identity capability: no private SDK fields, credentials or process ownership. */
export type ChildRouteModel = { provider: string; id: string; api: string; baseUrl: string };
export type ChildRoute = { baseUrl: string; upstream?: string };
export type ChildRouting = {
  canonical(provider: string, id: string): ChildRouteModel | undefined;
  route(provider: string, id: string, signal?: AbortSignal): Promise<ChildRoute | undefined>;
};
const key = Symbol.for("pi-setup.headroom.public-child-routing.v1");
function routes(): WeakMap<object, ChildRouting> {
  const state = globalThis as any;
  return state[key] ??= new WeakMap<object, ChildRouting>();
}
export function publishChildRouting(registry: object, routing: ChildRouting): () => void {
  routes().set(registry, routing);
  return () => { if (routes().get(registry) === routing) routes().delete(registry); };
}
export function childRouting(registry: object): ChildRouting | undefined { return routes().get(registry); }
