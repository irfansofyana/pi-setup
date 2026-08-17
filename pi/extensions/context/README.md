# `/context`

Package-owned, read-only active-session diagnostics. Separate from companion `pi-stats-ext` and `/pi-stats`.

## Behavior

- Registers exactly `/context`.
- Reports Pi context usage, session-file usage across all branches, active-branch entries, provider/model groups, tool result sizes/errors, and prompt contributor estimates.
- Labels provider-reported usage/cost separately from character/token estimates. Cost is metadata, not billing accounting.
- Reads `getEntries()`, `buildContextEntries()`, `getContextUsage()`, and `getSystemPromptOptions()` only. It does not append chat messages, call a model, mutate session/config, or write cache/files.
- Does not print raw system prompts, context-file contents, skill contents, or tool output. Metadata and bounded estimates only.
- Shows only context-pressure, prompt-overhead, and tool-bloat flags with observed values and thresholds.

In TUI mode, report opens in a theme-aware scrollable overlay. Press `q`, `Escape`, or `Ctrl-C` to close. Print, JSON, and RPC modes emit readable text through `console.log`.

Run `/reload` after package or extension updates before using `/context`.
