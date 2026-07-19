# Local Pi BTW Extension Research

Date: 2026-07-19

## Summary

Pi has enough extension primitives to build a local `/btw` side-question command without forking Pi: custom slash commands, access to the current session branch, current model/model registry, and UI notifications/status. Public Pi packages already explore the same space, but they split into two useful designs:

- lightweight side model call with no tools and no main-context pollution
- heavier real side sub-session/subagent with tool access and richer overlay UI

This repo now starts with the lightweight design in `pi/extensions/btw`. It is lower risk, easier to own, and still solves the immediate "ask while the agent is busy" workflow.

## Findings

### Pi extension primitives

Pi extensions are TypeScript modules loaded from `~/.pi/agent/extensions/` or project-local `.pi/extensions/`; `/reload` reloads auto-discovered extensions. They can register commands, tools, lifecycle hooks, and UI surfaces. Source: https://pi.dev/docs/latest/extensions

The key primitive for ordinary queued user messages is `pi.sendUserMessage()`, but that would add content to the main session. For `/btw`, the better path is a separate model call using the current session as read-only context. Source: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/send-user-message.ts

Pi's docs expose `ctx.sessionManager`, `ctx.modelRegistry`, `ctx.model`, `ctx.isIdle()`, UI notifications/status, and command handlers. That is enough for a side call that does not mutate the main transcript. Source: https://pi.dev/docs/latest/extensions

### Existing Pi `/btw` work

`dbachelder/pi-btw` is the most ambitious public implementation found. It opens a real Pi sub-session, can run immediately while the main agent is busy, keeps a continuous BTW thread, supports tangent/new/inject/summarize variants, supports model/thinking overrides, and can save a side exchange. Source: https://github.com/dbachelder/pi-btw

`@juicesharp/rpiv-btw` is a smaller package: `/btw <question>` asks a side question using a read-only clone of the current conversation, keeps side-thread follow-up history, shows a bottom panel, does not pollute the main transcript, and does not provide tools. Source: https://pi.dev/packages/%40juicesharp/rpiv-btw

`@narumitw/pi-btw` also provides a lightweight side channel. Its package docs emphasize optional model override using `provider/model-id`, optional thinking-level override, and fallback to the current Pi model when config is missing or invalid. Source: https://pi.dev/packages/%40narumitw/pi-btw

### Claude Code and other agents

Claude Code's `/btw` pattern is described publicly as a way to ask side questions while the main agent works, using full session context without adding the side conversation back into the main context. Source: https://blog.scottlogic.com/2026/06/18/working-effectively-with-claude-code.html

GitHub Copilot CLI users have requested the same behavior: ask a quick context-aware question while the agent is running, without writing to the session and ideally using a cheaper/smaller model. Source: https://github.com/github/copilot-cli/issues/2778

Codex has adjacent primitives through normal chat/session behavior and separate conversations, but no native Pi-style `/btw` command surfaced in the researched sources. The practical Codex equivalent is external orchestration: spawn a separate session/subagent with copied context, then keep its answer out of the main task unless explicitly injected.

## Options

### Option A: Lightweight side model call

Use current session messages as background, call the configured/current model with no tools, display the answer in UI, and keep hidden in-memory `/btw` history.

Pros:

- small code surface
- no main conversation pollution
- works without extra extension dependencies
- easy to audit and own

Cons:

- no file/tool access for the side answer
- notification UI is less polished than an overlay
- cannot edit or inspect files except from existing copied context

### Option B: Real side Pi process/sub-session

Spawn a separate `pi --mode json` process or true sub-session with a copied prompt/context.

Pros:

- can allow read-only or full tools
- closer to `dbachelder/pi-btw`
- better for repository exploration while main agent is busy

Cons:

- more process/session lifecycle risk
- harder permissions story
- must handle cancellation, streaming, JSON parsing, and cleanup

### Option C: Queue follow-up/steer message

Use `pi.sendUserMessage(..., { deliverAs: "followUp" | "steer" })`.

Pros:

- trivial
- native Pi behavior

Cons:

- not true `/btw`
- pollutes or redirects the main agent context
- can distract the working agent

## Recommendation

Start with Option A, which is what this branch implements. It solves Irfan's immediate need: ask `/btw` during work, keep the side chat separate, preserve follow-up context, and keep implementation local.

Implementation review update:

- Prefer Pi's current runtime auth resolver when available. The local extension reads `ctx.modelRegistry.runtime.getAuth(model)` via the exposed runtime object at execution time, carries resolved `apiKey`, `headers`, `env`, and `baseUrl`, and only falls back to the legacy `getApiKeyAndHeaders()` path for older Pi versions.
- Prefer compaction-aware context. The local extension reads `buildSessionContext()` when available, then `buildContextEntries()`, and only falls back to raw branch/session entries. It serializes compaction and branch summaries explicitly so side answers keep the same retained context that the main agent has after `/compact`.

V2 should add either:

- a bottom overlay/pager UI, or
- a read-only side Pi process for tool-using repository questions.

Do not jump directly to a tool-using side session until the lightweight command is comfortable. The risk is not TypeScript complexity; it is subtle session/permission behavior.
