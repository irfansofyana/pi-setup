# `/context`

Package-owned, read-only active-session facts. Separate from companion `pi-stats-ext` and `/pi-stats`.

## Behavior

- Registers exactly `/context`.
- Reports only exact, verifiable facts: provider-reported token usage (per turn, per model, summed), model-derived cost, the last completed turn's prompt size (input + cache read/write) against the configured context window, tool result sizes in chars/bytes, explicitly invoked skills, and prompt contributor char/byte sizes.
- Makes no token estimates. The only token figures are provider-reported fields (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`) plus the configured context window; the system prompt and prompt contributors are measured as chars/bytes, never converted to tokens.
- Labels cost as model-derived metadata, not provider billing accounting.
- Reads `getEntries()`, `buildContextEntries()`, `getSystemPrompt()`, and `getSystemPromptOptions()` only. It does not append chat messages, call a model, mutate session/config, or write cache/files.
- Does not print raw system prompts, context-file contents, skill contents, or tool output. Metadata and counts only.
- Flags a large tool result only when it exceeds exact char thresholds (aggregate >50,000 chars or a single result >20,000 chars).

In TUI mode, a compact dashboard opens by default — model/window, last-prompt bar (exact, previous turn), spend, turns/models, tool sizes, skills, session shape, and prompt size. Press `d` to toggle the full detail view; scroll with `j`/`k`, `g`/`G`, page-up/down; press `q`, `Escape`, or `Ctrl-C` to close. Print mode emits readable stdout; RPC mode sends a readable notification; JSON mode writes the report to stderr so structured stdout stays protocol-safe.

Run `/reload` after package or extension updates before using `/context`.
