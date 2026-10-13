# Irfan Devs Theme UI

Package-owned `pi-irfan-devs` bundle using phosphor design tokens:

- `theme.json`: green palette, amber/gold/cyan accents, near-black panels.
- `index.ts`: sole UI entrypoint; registers integrated editor and Signature.
- `signature.ts`: minimal header, native activity, footer session status and services, terminal title and inspection commands.
- `session-status.ts`: two-row footer layout, responsive metadata and counted status overflow.
- `footer-progress.ts`: session-local progress handoff between editor and footer; no extra timer.
- `codemode-ui.ts`: compact tool rows with original expanded rendering.
- `watermark-ui.ts`: layout-owned welcome widget, visibility, dock priority and cleanup.
- `watermark.ts`: bounded sizing, static idle and finite replay controller.
- `watermark-renderer.ts`: original π/badge geometry, 3D projection and Braille rasterization.
- `watermark-session.ts`: conservative fresh-session eligibility.
- Adjacent tests and smoke scripts: renderer/controller invariants and native Pi integration.

Pi loads palette and executable UI through separate manifest fields. Only
`index.ts` loads the runtime; no standalone Signature adapter or compatibility aliases.

## Welcome panel

Header is one line: `π · ~/project`. A fresh, idle fullscreen
session with an empty draft displays a faint dotted π in reserved rows above
the editor. This is a layout-owned widget, not an overlay or background layer.

- Startup warnings, reload text and the native `/new` notice remain in the transcript; they do not suppress artwork.
- Plain left-click within the artwork stage replays original `π → circular π badge → π` rotation/morph. Keyboard alternative: `/pi-watermark` or `/pi-watermark replay`.
- Idle artwork is static at opacity `0.18`, with no frame timer. Replay lasts 7.2 seconds plus a 400-ms return fade; repeated clicks reset one timer.
- Typing hides artwork and cancels replay. Clearing an unsent draft restores static artwork, not animation.
- Submission, agent/message activity, bash, history navigation or image/paste gestures retire artwork until a fresh session.
- Dialogs, autocomplete, regular mode and small terminals suppress it.
- `PI_SIGNATURE_ANIMATION=0` keeps static artwork but disables click/command replay; working spinner is independent.
- Other palettes retain their existing orbit header.

Artwork is centered inside its reserved panel, not at an arbitrary screen
coordinate. It uses at most 60×24 artwork cells plus margins, targeting 55% of
terminal height while preserving the dock/transcript budget. The taller bottom-anchored
panel makes the logo larger and raises its center compared with the former 16-row cap.
Usually at least 48×30 terminal cells are needed; exact eligibility depends on input/dock rows.

### Content gets priority

The panel budgets native pending/status/widget/editor/footer rows and preserves
at least eight transcript rows. Standard Text/Spacer widgets coexist; decoration
shrinks or disappears before their content is clipped. Opaque custom dock
components or unsupported layouts suppress artwork instead of guessing their
size. Only supported public leaf components are measured; no private layout
caches, whole-transcript rendering polls or core patches. Dock budgeting recognizes
Pi 1.0.2's seven-container composition; incompatible layouts fail closed with
an explanatory status.

### Diagnose visibility

Run:

```text
/pi-watermark status
```

Status reports draft, activity/history, focus/dialog, autocomplete, mode, size,
unknown dock content or missing widget registration. Startup/reload eligibility
also requires an unpersisted metadata-only session. Resumes/forks are excluded.
Use `/new` for a fresh session when history/persistence blocks artwork.

## Working interface

Original green-led identity, with softer phosphor, amber/gold/cyan accents and
near-neutral green-tinted tool surfaces. Headings use primary text; code strings
use soft green rather than a bright yellow wall. Search, selection and message
backgrounds are distinct. Terminal background and font remain user-owned.

The custom footer has two rows below the composer:

1. Project/branch, model, thinking level, context and cost; progress at the far right.
2. Service chips (blank when no services publish status).

Todos and subagents keep the above-input space. Long project/branch names shorten;
project, thinking and cost yield before model/context in narrow panes. Quips shrink
to a spinner when space is tight; factual tool/recovery text gets priority and can
replace metadata in tiny panes. Unknown context displays `ctx ?`, never a made-up
zero. Both footer rows are measured in the welcome artwork budget. Costs
use primary text; model/context use secondary text. Healthy service values use
soft green (`#8fbd9c`); separators use subdued `#59665f`. Failures and context
pressure retain warning/error colors (above 70% and above 90%). Whole-chip
overflow shows `+N`; inspect all statuses and main-session token/cache counters
with read-only `/pi-ui`. Caveman mode appears once without a duplicate icon/label.

The native Pi loader owns working, retry and compaction lifecycle. Its single
indicator appears at the right of the first footer row, with no extra progress
row above or below the composer. Generic working text becomes
24 original short quips, rotating every 6.6 seconds on native animation updates;
active tool counts/names, retry and compaction messages remain factual. Narrow
panes drop the whole quip before the spinner. Idle shows no `ready` label.
The large dotted π artwork and its replay animation are unchanged. Tool failures
stay in their result cards: they do not recolor the composer or leave a sticky
`tool error` label. Native retry messages replace quips only during actual retries.

### Compact codemode

Collapsed `codemode` rows show preparation/running/completion, duration when
known, call counts, failures/cancellations and an expansion hint. Raw script and
successful output stay behind Pi's existing tool expansion action; nested errors
and script failure previews remain visible. Collapsed failures show the primary
cause without the stack dump, plus a warning when prior calls were not undone.
Counts and expansion hints stay muted; failure causes remain red. Expanded views
delegate to the original renderer, preserving full output, stacks and call details. Once expanded during a run, native
lifecycle updates continue through final cleanup even after collapsing. Native tool
framing, images and execution behavior remain Pi-owned.

Only `codemode` is customized. Other tools, specialized self-renderers and other
palettes retain their renderers. No arguments/results, model context, cost ledger,
installed settings or external footer configuration are changed. Hosts without
`registerToolRenderer` retain native rendering. `PI_SIGNATURE_COMPACT_FOOTER=0`
retains the native footer instead of the two custom rows. If the custom footer is
disabled or replaced, native progress falls back to a single row below the editor.
Replacing the editor relinquishes this progress handoff to Pi. Other palettes
retain their existing footer layout.

## Footer accounting

The single dollar value combines main-session assistant cost and settled subagent
costs from persisted `pi-subagent:cost:v1` records. Per-child high-water marks
prevent duplicate charges after resumes, reloads, or branch navigation. Running
children contribute when they settle; the value is not a live billing meter.
Input/output/cache tokens and context usage still describe the main session only.

Signature hides the separate `subagent_cost` status chip because its cost is
already included. The subagent extension still publishes that key/event for other
footer consumers; agent task details retain individual costs. No user settings or
external footer configuration are changed.

## Editor and ownership

Quiet top/bottom separators replace the rounded frame. The shortcut hint is
hidden; file mentions, slash commands and native newline keybindings still work. Short terminals omit the
top separator; autocomplete and pathological widths use stock fallbacks.
Input remains delegated to `CustomEditor`; Pi's host `onChange` stays intact.
The root editor factory registers its exact instance and app keybindings in a process-local weak registry.
Package UI adapters use that identity to distinguish Main from dialog editors;
reusing the editor class does not mark a dialog or alter its callbacks.
Navigation can compare app and TUI bindings without inspecting editor internals.
Disposable root input hooks run only after extension shortcuts decline an event.
The theme dispatches native input once and restores the temporary shortcut wrapper
afterward; dialog editors and host submission callbacks retain their own behavior.

Pi has one editor slot. Conflicts warn and preserve last-loaded-wins behavior;
the bundle never forcefully reclaims another editor. Terminal settings own base
background and font; `#111613`, Fira Code or JetBrains Mono are optional choices.

Requires Pi `>=1.0.0`; optional renderer API is capability-checked. Redesign APIs
were inspected in Pi 1.1.0 and 1.2.0; previous bundle smoke covered 1.0.2.
Redesign runtime/visual validation is pending a hard-limited runner. Host packages
come from Pi; no additional runtime dependency or settings mutation is needed.

## Validation

```bash
npm run test:signature
PI_ROOT="/path/to/installed/@earendil-works/pi-coding-agent" npm run test:themes
```

Native smoke uses real loader, widget registration, viewport, `/new` and mode
switch methods. Covers warning/reload notices, click/focus, IME/editor behavior,
typing/clear, dock pressure in both sibling orders, disposal/replacement,
theme/resize and unanswered terminal-color queries.

Local renderer-only benchmark: 150 frames at 60×16; initialization 19.3 ms,
median 0.31 ms, P95 0.59 ms, maximum 2.80 ms against a 50-ms replay frame budget.
These are local measurements, not terminal bandwidth or hardware guarantees.
Actual terminal appearance still needs interactive visual review.

Package bootstrap belongs to [Installation](../../../docs/setup/installation.md#install-the-package).
After UI/package changes, run `/reload` or restart Pi, then `/new` to preview
outside an existing conversation.
