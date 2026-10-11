export const failureCodes = ["unsupported_provider", "unsupported_resource", "unsupported_routing", "initialization_failed", "execution_failed"] as const;
export type RunFailure = Readonly<{ code: typeof failureCodes[number] }>;

/** Only known codes cross the result boundary; raw exceptions can contain credentials. */
export function runFailure(error: unknown): RunFailure {
  const message = error instanceof Error ? error.message : undefined;
  return Object.freeze({ code: failureCodes.includes(message as any) ? message as RunFailure["code"] : "execution_failed" });
}

export function failureSummary(failure: RunFailure): string {
  const hints: Record<RunFailure["code"], string> = {
    unsupported_provider: "exact model or parent authentication unavailable",
    unsupported_resource: "required child tools, extensions or skills unavailable",
    unsupported_routing: "approved provider route unavailable",
    initialization_failed: "child SDK session initialization failed",
    execution_failed: "child execution failed; raw provider errors are not retained",
  };
  return `${failure.code}: ${hints[failure.code]}`;
}
