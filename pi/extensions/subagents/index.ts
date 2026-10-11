// Auto-loaded package glob. Native runtime defaults on; user opt-out and companion checks remain.
export function activationDecision({ requested, companionPresent }: { requested: boolean; companionPresent: boolean }): { enabled: boolean; reason: string } {
  if (!requested) return { enabled: false, reason: "not_requested" };
  if (companionPresent) return { enabled: false, reason: "companion_conflict" };
  return { enabled: true, reason: "explicit_native_activation" };
}
export default async function subagents(pi: unknown): Promise<void> {
  if (process.env.PI_SETUP_SUBAGENTS_NATIVE === "0") return;
  const { registerNative } = await import("./runtime.ts");
  await registerNative(pi as never);
}
