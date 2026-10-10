// Auto-loaded by the package glob; neither old enable flags nor project files activate it.
export function activationDecision({ requested, companionPresent }: { requested: boolean; companionPresent: boolean }): { enabled: boolean; reason: string } {
  if (!requested) return { enabled: false, reason: "not_requested" };
  if (companionPresent) return { enabled: false, reason: "companion_conflict" };
  return { enabled: true, reason: "explicit_native_activation" };
}
// Declarative rehearsal inventory, not an installer or loader. M1 must prove isolation
// against a temporary Pi home before a pre-registration gate can be safely introduced.
export function isolatedProfile() {
  return { temporaryHomeOnly: true, packageSources: ["@irfansofyana/pi-setup", "@ff-labs/pi-fff"], extensionResources: ["subagents", "web-research", "headroom", "fff"], active: false } as const;
}
export default async function subagents(pi: unknown): Promise<void> {
  if(process.env.PI_SETUP_SUBAGENTS_PREVIEW==="1"){
    const {registerPreview}=await import("./preview-extension.ts");await registerPreview(pi as never);return;
  }
  if(process.env.PI_SETUP_SUBAGENTS_NATIVE!=="1")return;
  const {registerNative}=await import("./preview-extension.ts");await registerNative(pi as never);
}
