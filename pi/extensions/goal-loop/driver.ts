export const GOAL_DRIVER_REQUEST_EVENT = "goal-loop:driver:request";
export const GOAL_DRIVER_RESPONSE_PREFIX = "goal-loop:driver:response:";

export interface GoalDriverClaim {
  owner: "loop";
  projectRoot: string;
  sessionId: string;
  generation: number;
}

export type GoalDriverRequest = GoalDriverClaim & {
  requestId: string;
  action: "claim" | "release" | "status";
};

export type GoalDriverResponse =
  | { ok: true; claim?: GoalDriverClaim }
  | { ok: false; reason: string; claim?: GoalDriverClaim };

export function parseGoalDriverRequest(value: unknown): GoalDriverRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.action !== "claim" && raw.action !== "release" && raw.action !== "status") return undefined;
  if (raw.owner !== "loop") return undefined;
  if (typeof raw.requestId !== "string" || !raw.requestId) return undefined;
  if (typeof raw.projectRoot !== "string" || !raw.projectRoot) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId) return undefined;
  if (!Number.isSafeInteger(raw.generation) || (raw.generation as number) < 1) return undefined;
  return raw as unknown as GoalDriverRequest;
}

export class GoalDriverRegistry {
  private claim?: GoalDriverClaim;

  current(projectRoot?: string): GoalDriverClaim | undefined {
    if (!this.claim || (projectRoot && this.claim.projectRoot !== projectRoot)) return undefined;
    return { ...this.claim };
  }

  isClaimed(projectRoot: string): boolean {
    return this.claim?.projectRoot === projectRoot;
  }

  handle(request: GoalDriverRequest, hasActiveGoal: boolean): GoalDriverResponse {
    if (request.action === "status") return { ok: true, claim: this.current(request.projectRoot) };

    if (request.action === "claim") {
      if (hasActiveGoal) return { ok: false, reason: "An active /goal already owns this working root." };
      if (this.claim) {
        const same =
          this.claim.owner === request.owner &&
          this.claim.projectRoot === request.projectRoot &&
          this.claim.sessionId === request.sessionId &&
          this.claim.generation === request.generation;
        return same
          ? { ok: true, claim: this.current() }
          : { ok: false, reason: "Another loop driver already owns this Pi process.", claim: this.current() };
      }
      this.claim = {
        owner: request.owner,
        projectRoot: request.projectRoot,
        sessionId: request.sessionId,
        generation: request.generation,
      };
      return { ok: true, claim: this.current() };
    }

    if (!this.claim) return { ok: true };
    const matches =
      this.claim.owner === request.owner &&
      this.claim.projectRoot === request.projectRoot &&
      this.claim.sessionId === request.sessionId &&
      this.claim.generation === request.generation;
    if (!matches) return { ok: false, reason: "Loop driver release did not match current ownership.", claim: this.current() };
    this.claim = undefined;
    return { ok: true };
  }

  releaseSession(sessionId: string): void {
    if (this.claim?.sessionId === sessionId) this.claim = undefined;
  }
}
