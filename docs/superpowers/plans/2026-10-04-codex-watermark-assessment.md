# Codex-style interactive Pi watermark assessment

## Decision update: layout-owned welcome panel

**Shipped integration supersedes the original overlay proposal below.** User
approved a reserved welcome panel after startup extension warnings prevented
the strict empty-screen overlay from showing. `ctx.ui.setWidget()` now owns
artwork rows above the editor; warnings remain in the transcript. Native dock
budgeting gives meaningful widgets/input priority and yields for opaque
components. No background/core patch or settings/package mutation is needed.

See [current component behavior](../../../pi/themes/pi-irfan-devs/README.md#welcome-panel).
Renderer uses original Pi geometry, static idle and finite click-triggered 3D
replay. `/pi-watermark status` makes suppression observable.

The remaining assessment records original Codex research and historical
overlay feasibility, not the current mounting implementation. Earlier prominent
continuously pulsing header direction is also superseded.

## Evidence scope

- Installed binaries: `codex-cli 0.160.0` and Pi `1.0.2`.
- Codex sources below are pinned to `rust-v0.160.0`, not repository `main`.
- Screenshots show both frontal and side-facing dotted Codex marks after a click.
- Pi evidence comes from the installed package's declarations, implementation,
  and an in-memory terminal integration probe.
- Fetched GitHub extraction loses some Rust syntax. Inspect original tagged
  source before translating code; extracted text is not suitable for copying.

## How Codex achieves it

### Confirmed from tagged source

1. **Real 3D rendering, not a pulse.** The renderer describes itself as
   “Deterministic surface projection Braille rasterization of Codex logo morph.”
   It projects beveled front/back surfaces and edge layers, applies rotation,
   perspective, depth-buffer occlusion, and lighting. [Renderer][renderer]
2. **Two shapes morph while rotating.** SVG paths for the Codex mark and OpenAI
   knot become cached 160×160 signed-distance fields. The renderer blends the
   fields over the animation phase. [Geometry][geometry], [paths][paths],
   [renderer][renderer]
3. **Dots are Unicode Braille.** Each character packs a 2×4 dot grid using
   `0x2800 + dotMask`. Shading is averaged per cell, and colors blend against
   the terminal background. No image protocol or browser canvas is required.
   [Renderer][renderer], [lighting][lighting]
4. **Idle is genuinely idle.** Fresh conversations start settled; a click
   replays the animation. The controller says “Visible time pauses while hidden.”
   Settled first-screen rendering returns no next-frame delay. Active animation
   requests frames at 50 ms intervals, about 20 FPS. [Controller][controller]
5. **Clicks have bounded ownership.** Replay accepts an unmodified left-button
   press inside the displayed stage rectangle. Other gestures keep their normal
   owner. It does not use a global click-anywhere trigger. [Controller][controller]
6. **Typing hides the decoration.** The first-screen controller evaluates
   composer state and available screen space. Its documentation states:
   “The centered blossom returns on clear, without restarting or scheduling an
   animation.” [Controller][controller]
7. **Conversation eligibility is conservative.** Startup metadata is explicitly
   allowlisted. Unknown history-cell types count as activity, even if they render
   no visible text. Resumed/forked threads do not acquire fresh-thread eligibility.
   [Policy][policy], [controller][controller]

### Timing

[Sequence constants][sequence] define:

| Parameter | Codex value |
| --- | --- |
| Static opacity | 0.18 |
| Brightness/fade transition | 400 ms |
| Rotation loop | 7.2 seconds; two complete rotations |
| Spin-duration ceiling | 10.8 seconds |
| Easing | Quintic smootherstep: `t³ × (t × (6t − 15) + 10)` |

The click handler starts at phase `0.5 × 7.2 = 3.6` seconds. Consequently, about
7.2 seconds of replay remain before the 400 ms return fade. That duration is
**inferred from controller arithmetic**, not measured from an interactive run.

The first-screen stage targets 60 columns and 21 rows, requires at least 14 rows,
and uses four-column screen margins. Pi should adapt these dimensions to its own
available space, not blindly use Codex's layout numbers. [Controller][controller]

## Pi compatibility assessment

| Need | Pi 1.0.2 support | Assessment |
| --- | --- | --- |
| Dot-based terminal rendering | `Component.render(width): string[]`, Unicode/ANSI output | Supported |
| Native foreground/background mixing | `theme.colors`, `mixColors()` | Supported; use the actual terminal background |
| Floating decoration without transcript rows | `TUI.showOverlay()` | Supported; this is compositing, not a true background layer |
| Retain editor keyboard focus | `OverlayOptions.nonCapturing: true` | Verified by probe |
| Local pointer coordinates | `Component.handleMouse(TuiMouseEvent)` | Verified by probe |
| Suppress click focus transfer | `{ handled: true, focus: false }` | Verified by probe |
| Hide during typing/paste | Visibility callback reads `ctx.ui.getEditorText()` | API exists; typing path verified by probe |
| Responsive sizing/hiding | `visible(width, height)`, margins, anchors, `getBounds()` | Small-viewport hiding verified by probe |
| Finite animation updates | `requestRender()` and component invalidation | Supported; never force full-tree polling |
| Session/lifecycle cleanup | Session/agent events and component `dispose()` | Supported; needs implementation tests |
| Mouse clicks in regular scrollback mode | No equivalent native mouse routing | Disable watermark in regular mode |

Pi's `TuiAltScreen` routes mouse input to visible overlays even when they are
non-capturing. Keyboard-focus ownership and pointer hit-testing are separate.

Local global settings do not explicitly select `tuiMode`. Pi 1.0.2 defaults to
`fullscreen` when that setting is absent. A CLI or project override can still
select regular mode; check the actual `tui.mode` at runtime. No settings mutation
is needed for the default configuration.

### Verified integration probe

Ran against the actual installed `@earendil-works/pi-tui` package, with an
in-memory 80×30 terminal, `TuiAltScreen`, and a simple editor-like component
(not the full Pi interactive app). **All assertions passed:**

- Non-capturing overlay appears without taking editor focus.
- SGR mouse press/release produces a normalized click with correct local coords.
- Clicking the overlay leaves editor focused and overlay unfocused.
- Typing reaches the editor and hides the watermark in the same rendered frame.
- Clearing the editor restores the empty-state decoration.
- Resizing to 42×14 suppresses the decoration.

This probe validates APIs, not final π artwork, renderer performance, real
terminal appearance, paste/image handling, or every dialog/extension interaction.

## Recommended Pi implementation

### Visual and interaction contract

- One-line header: `π pi-irfan-devs · ~/project`.
- Large, faint, centered dotted `π` in an otherwise empty chat area.
- Static at rest: no perpetual idle timer or breathing header.
- Click inside the logo stage to brighten, rotate in 3D, then fade back to rest.
- For a closer Codex-style morph, use two **original Pi shapes**: standalone `π`
  and a circular `π` badge. Do not ship Codex/OpenAI logo paths.
- Hide immediately on nonempty draft, paste, agent activity, or conversation
  content. Clearing an unsent draft may restore the static watermark.
- Never show over a resumed conversation; only reset eligibility for a genuinely
  fresh empty session.
- Preserve keyboard focus, IME cursor placement, editor shortcuts, autocomplete,
  mouse selection, wheel scrolling, existing widgets, and editor/footer styling.
- Small terminals and regular mode get only the minimal header.
- Preserve `PI_SIGNATURE_ANIMATION=0`: static decoration, no animated replay.

### Module ownership

Keep all implementation under `pi/themes/pi-irfan-devs/`; continue loading only
its canonical `index.ts` entrypoint.

- `watermark-geometry.ts`: original π/badge shapes and cached sampling data.
- `watermark.ts`: deterministic 3D/Braille renderer plus lifecycle controller.
- `signature.ts`: minimal header and integration with session/editor state.
- `watermark.test.ts` and existing Signature tests: geometry, states, scheduling,
  mouse/focus, theme changes, resizing, and cleanup.

Do not add a second terminal renderer, standalone extension, dependency,
package source, or local configuration override for this feature.

### Rendering and lifecycle safeguards

- Cache geometry once. Reuse typed buffers for projection, depth, and dot masks.
- Bound resolution/stage size; benchmark TypeScript frame cost before release.
- Start with Codex-like 20 FPS only during replay; no continuous idle scheduling.
- Use monotonic elapsed time, not interval tick counts, for rotation and fades.
- Stop pending callbacks on hide, nonempty input, theme exit, session replacement,
  shutdown, or component disposal. Restoring visibility must not replay by itself.
- Use ordinary coalesced `requestRender()`, never `requestRender(true)` or
  repeated calls to the full TUI render tree.
- Read editor text through the public API. Do not overwrite Pi's `onChange`
  callback: Pi wires that callback after creating a custom editor and uses it for
  native bash-mode behavior.
- Blend against the terminal background, not an assumed theme panel color.
  Rebuild color caches on theme/palette changes.

## Limits and remaining verification

- An overlay is composited above the base view. It must stay confined to empty
  space; it is not a general behind-transcript background API.
- Public extension APIs do not provide a general transcript-pane rectangle.
  Conservative margins and fail-closed visibility are necessary around unknown
  widgets/startup content. Validate real layout before claiming non-overlap.
- Arbitrary third-party widgets, dialogs, and transient content need interaction
  tests; the isolated probe does not prove all extension combinations safe.
- Terminal font/aspect ratio, Braille coverage, truecolor/256-color output, and
  accessibility settings prevent a pixel-identical promise.
- Actual 3D renderer CPU cost and output bandwidth remain unmeasured.
- Image attachments without draft text may not be observable through editor text
  alone. Verify a public paste hook or suppress decoration on the paste gesture;
  do not inspect private app state to infer pending attachments.
- Codex's complete app-level motion-settings mapping and every scheduler call
  site were not retrieved. This does not block Pi's independent controller.

If the requirement expands to a true background behind arbitrary conversation
content, assess a native Pi layout/render hook rather than reaching into private
render caches or monkey-patching the app.

## Licensing

Codex source is Apache-2.0 licensed. If code is copied or translated, preserve
required license/attribution notices, mark modified files, and inspect any
applicable NOTICE material. The source license does not itself grant trademark
rights. Use original Pi artwork. [License][license]

## Acceptance tests before activation

1. Deterministic original π silhouette, front/side depth, morph endpoints,
   Braille masks, color/opacity, width limits, and resize behavior.
2. Zero idle frame timer; bounded replay; repeated-click reset; all cleanup paths.
3. Typing, text/image paste, autocomplete, draft clear, first submission, tools,
   resumed/forked sessions, theme changes, and `/reload`.
4. Editor focus/cursor/IME intact; dialog controls, selection, dragging, and
   wheel scrolling intact. No scrollback-clearing animation behavior.
5. Real terminal visual review at normal/small sizes and both TUI modes.
6. Existing full test suite and real-Pi theme smoke test pass.

[controller]: https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/empty_state_animation.rs
[renderer]: https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/empty_state_animation/renderer.rs
[geometry]: https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/empty_state_animation/geometry.rs
[paths]: https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/empty_state_animation/paths.rs
[sequence]: https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/empty_state_animation/sequence.rs
[policy]: https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/empty_state_animation/policy.rs
[lighting]: https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/empty_state_animation/lighting.rs
[license]: https://github.com/openai/codex/blob/rust-v0.160.0/LICENSE
