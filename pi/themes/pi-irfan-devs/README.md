# Irfan Devs Theme UI

Package-owned `pi-irfan-devs` bundle using phosphor design tokens:

- `theme.json`: green palette, amber/gold/cyan accents, near-black panels.
- `index.ts`: sole UI entrypoint; registers integrated editor and Signature.
- `signature.ts`: minimal header, working indicator, footer statistics/statuses, terminal title and replay/status command.
- `watermark-ui.ts`: layout-owned welcome widget, visibility, dock priority and cleanup.
- `watermark.ts`: bounded sizing, static idle and finite replay controller.
- `watermark-renderer.ts`: original π/badge geometry, 3D projection and Braille rasterization.
- `watermark-session.ts`: conservative fresh-session eligibility.
- Adjacent tests and smoke scripts: renderer/controller invariants and native Pi integration.

Pi loads palette and executable UI through separate manifest fields. Only
`index.ts` loads the runtime; no standalone Signature adapter or compatibility aliases.

## Welcome panel

Header is one line: `π pi-irfan-devs · ~/project`. A fresh, idle fullscreen
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

## Footer presentation

For `pi-irfan-devs`, the footer uses the terminal's default background rather
than a filled panel. Cost uses primary text; model and normal context use
secondary text. Tokens, paths, providers and service labels stay muted. Healthy
service values use footer-local soft green (`#8fbd9c`); separators use subdued
`#59665f`. Active work retains accent color; failures and context pressure retain
warning/error colors (context warning above 70%, error above 90%). Caveman status
shows its mode once, without the rock icon or duplicated label.

Reasoning-capable models show the current configured thinking level beside their
name (for example, `gpt-6-astra · thinking high`, including `thinking off`). The
level is read on each render; models without reasoning omit it. The provider
prefix is omitted when space is needed for the model/thinking label.

These are footer-only styles: global palette, editor thinking border, agent badge
colors and other palettes remain unchanged. Layout and accounting are unchanged.

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

Rounded frame requires at least 34 columns and 18 rows. Smaller terminals keep
compact rails; autocomplete and pathological widths use stock fallbacks.
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

Requires Pi `>=1.0.0`; validated against `1.0.2`. Host packages come from Pi;
no additional runtime dependency or settings mutation is needed.

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
