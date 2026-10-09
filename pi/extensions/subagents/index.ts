// Auto-loaded by the package glob. M0 deliberately has no activation path: no competing
// registrations, timers, workers, provider routes or writes, even if an env flag is set.
export function activationDecision({ requested, companionPresent }: { requested: boolean; companionPresent: boolean }): { enabled: false; reason: string } {
  if (!requested) return { enabled: false, reason: "not_requested" };
  if (companionPresent) return { enabled: false, reason: "companion_conflict" };
  return { enabled: false, reason: "backend_not_implemented" };
}
// Declarative rehearsal inventory, not an installer or loader. M1 must prove isolation
// against a temporary Pi home before a pre-registration gate can be safely introduced.
export function isolatedProfile() {
  return { temporaryHomeOnly: true, packageSources: ["@irfansofyana/pi-setup", "@ff-labs/pi-fff"], extensionResources: ["subagents", "web-research", "headroom", "fff"], active: false } as const;
}
export default function subagents(_pi: unknown): void {
  // Intentionally empty until backend/companion-exclusive activation is tested.
}
