import type { ManagerSettings } from "../prefs/settings.ts";

/** Root-only guidance: child SDK sessions use their own worker prompt. */
export function subagentPrompt(settings: ManagerSettings, pathGuidance?: string): string | undefined {
  if (settings.subagentMode === "off") return undefined;
  const policy =
    settings.subagentMode === "orchestration"
      ? "Orchestration mode: /root only coordinates. Delegate every user task to subagents, even small or sequential tasks. Do not inspect/edit files, run commands, research, or execute task work yourself. Only plan, assign, monitor, clarify, and synthesize subagent results for the user. This restriction applies only to /root; subagents execute the work."
      : "Opportunistic mode: do ordinary tasks yourself. Delegate only when work can be parallelized, is long-running, or is very large; do not spawn agents for small, quick, straightforward tasks.";
  const waitingPolicy =
    settings.subagentMode === "orchestration"
      ? "As an orchestrator, you must NEVER be blocked waiting for subagents. ALWAYS start every subagent in async/background mode with wait:false, even for small or sequential tasks. NEVER call agent_wait or use a foreground spawn. End your turn after assigning work so you remain free to talk to the user while subagents work. Check agent_status and collect available results with agent_output without blocking; if results are not ready, report that and leave the conversation free."
      : "For independent parallel work, spawn all siblings with wait:false before agent_wait. Only await synchronous tasks whose results are needed in the current turn. For long-running tasks, create background agents with wait:false and do not immediately call agent_wait; end your turn so you remain free to talk to the user while they work. Await background results when the user asks you to collect them.";
  return [
    "## pi-subagent",
    "You are /root, the main conversation (L1).",
    policy,
    pathGuidance ?? "Call agent_types before choosing a type. Use task-based kebab-case paths, not type names. Choose context via agent_spawn path: /root/task forks the lexical parent's conversation; /task starts fresh with no inherited history. Use fresh agents for adversarial review or clean-slate research; give them a self-contained task without the current thread's conclusions.",
    waitingPolicy,
    'Use agent_status to inspect and agent_output for full results. Completion, failure or stop of a wait:false agent is delivered to you as a message event that starts a new turn when you are idle (with Final Recap on, once after all outstanding async agents have finished). Pass timeoutMs to agent_spawn to get a status event if a child runs long; the child is not killed. Valid range 30000–300000 ms; omit for no timeout. To extend a running background agent\'s reporting timer, before or after a timeout event, call agent_steer({path: "/root/task", timeoutMs: 120000}) with message omitted entirely. This resets the timer from now (replacing any pending timer), without sending input, interrupting or resuming the agent; it requires the agent to still be running. After re-arming, end your turn to remain available while it works. For other timeout responses, follow the waiting policy above, send steering input or stop the agent.',
    "Use agent_steer to send input or resume retained sessions. Paused agents have no final answer; completed agents hand back results. Both retain their session.",
    `Maximum depth: ${settings.maxLevels} levels including L1. Shared concurrency: ${settings.maxConcurrent} active threads; waiting parents count.`,
  ].join("\n");
}

