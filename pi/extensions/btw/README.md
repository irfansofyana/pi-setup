# Local BTW Pi Extension

Small local Pi extension that adds `/btw` for side questions while the main agent is working.

It makes a separate one-off model call using Pi's current auth/runtime configuration, a compaction-aware snapshot of the current session, and the local `/btw` side-thread history. The answer is shown through Pi UI notifications and is not appended to the main conversation.

## Install

From repository root, use canonical private backup-and-replace procedure in [setup installation guide](../../../docs/setup/installation.md#install-local-templates).

Then reload Pi:

```text
/reload
```

## Usage

```text
/btw what file owns this router?
/btw why is the agent editing package-lock?
/btw status
/btw clear
```

## Config

Optional config path:

```text
~/.pi/agent/btw/config.json
```

Example:

```json
{
  "model": "openrouter/openai/gpt-5-mini",
  "thinkingLevel": "low",
  "maxContextChars": 40000,
  "maxHistoryTurns": 8
}
```

- `model` uses `provider/model-id`. If omitted, `/btw` uses the current Pi model.
- `thinkingLevel` can be `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. If omitted, `/btw` inherits the current Pi thinking level.
- `maxContextChars` bounds the copied main-session text.
- `maxHistoryTurns` bounds the hidden side-thread follow-up history.

## Trade-offs

- This first local version has no bottom overlay and no tools.
- It is safe for side chat because it does not call `pi.sendUserMessage()` and does not write `/btw` entries into the main session.
- It prefers Pi's current model runtime for auth and completion, so extension-registered/native provider transports stay intact.
- It omits `reasoning` when `thinkingLevel` is `off`, matching Pi's own simple-call behavior.
- It prefers `buildSessionContext()`/`buildContextEntries()`, so compaction and branch summaries remain visible to side answers.
- It skips `bashExecution` messages marked `excludeFromContext`, matching Pi's intent for `!!` commands.
- For tool-using side agents, build a later v2 that spawns a separate Pi JSON process or real sub-session.
