# pi-irfan-devs: terminal UX audit and roadmap

Research date: 2026-10-13. Analysis and proposals only; no runtime or configuration changes.

## Recommendation

Refine our original green-led identity; do not copy Hermes colors or branding. User clarified that Hermes is a UX reference only. Make the working interface quieter, more informative, and easier to inspect. The largest opportunity is **information hierarchy**.

First-slice implementation now lives in the [component README](../../pi/themes/pi-irfan-devs/README.md). This research remains a roadmap, not proof of runtime/visual validation.

Target: **conversation-first, state-aware, details on demand**. Preserve Pi's regular/fullscreen modes and native editor behavior rather than building a second terminal renderer.

## Evidence and limits

- Local evidence: [component README](../../pi/themes/pi-irfan-devs/README.md), [editor](../../pi/themes/pi-irfan-devs/index.ts), [Signature/footer](../../pi/themes/pi-irfan-devs/signature.ts), [footer styles](../../pi/themes/pi-irfan-devs/footer-style.ts), and [palette](../../pi/themes/pi-irfan-devs/theme.json).
- Compatibility reference: installed Pi 1.2.0 `docs/themes.md` and `docs/tui.md`. Component README currently records validation against 1.0.2; that is not proof of full 1.2.0 validation.
- External evidence: two researchers fetched official documentation/source bodies listed below. Documented features are not hands-on test results. No comparative latency, accessibility, or usability benchmark was run.
- Most external docs are rolling and undated. OpenCode v2 parity remains unresolved. Claude fullscreen is documented as a research preview. fx provisionally means Vercel Labs fx; user confirmation is pending.
- Recommendations and proposed layouts below are design judgments, not existing product capabilities or implementation commitments.

## Comparison: what to borrow

| Agent | Documented pattern | Lesson for Pi | Important limit |
|---|---|---|---|
| OpenCode | Tool/reasoning detail toggles, command palette, width-adaptive or stacked diffs [O1] | Make details discoverable; favor stacked diffs in narrow panes | Existing `/docs` advertises separate v2; do not assume feature parity |
| Claude Code | Classic/fullscreen surfaces; expandable results and focused summaries; configurable model/context status [C1–C3] | Optimize the default conversation for outcomes, with inspection one action away | Fullscreen is preview; core rendering behavior is not a theme feature |
| Codex CLI | Configurable/reorderable status items, model/status commands, alternate-screen opt-out [X1] | Let users choose essential telemetry while preserving a useful default | Exact tool-collapse/diff layout and accessibility behavior not established |
| fx, provisionally Vercel | Normal terminal scrollback, full transcript details, draft-preserving model picker [F1–F3] | Treat copy, scrollback, drafts and output stability as first-class UX | Experimental; site reported v0.0.13; repository main may differ |
| Hermes | Detail levels, agent observability overlay, categorized help, responsive status [H1–H2] | Put rich operational information in inspectable views, not permanent chrome | Classic CLI remains shipped default; modern TUI is a distinct surface |
| pi-irfan-devs today | Native editor delegation, integrated footer, content-budgeted welcome, theme-owned identity | Strong foundation; improve prioritization before adding surfaces | Audit is source-based, not live visual testing |

### Specific transferable findings

**OpenCode.** `/details` and `/thinking` separate tool/reasoning detail from the conversation. `diff_style: auto` adapts to width; `stacked` requests a single-column diff. `/help`, slash commands and `Ctrl+P` support discovery. Mouse capture can be disabled to preserve terminal selection. Permission choices include once, always and reject; documented “always” is session-scoped matching patterns [O1–O2]. Borrow explicit scope labels only where Pi actually has a corresponding control; a theme cannot create execution enforcement.

**Claude Code.** Classic and fullscreen renderers coexist. Fullscreen uses the alternate screen, bottom-fixed input and expandable tool results. `/focus` offers a last-prompt/tool-summary/final-response view. Status-line data exposes model and context. Screen-reader mode normally chooses classic rendering, with documented exceptions; ANSI and daltonized theme bases exist [C1–C4]. Borrow disclosure and semantic distinction, not undocumented claims that one renderer is universally better.

**Codex CLI.** `/statusline` configures items including model/reasoning, context, limits, branch and counters. `/model` and `/status` make model changes inspectable. `--no-alt-screen` provides an alternate-screen opt-out. Approval policy and sandbox policy are separate controls [X1]. Borrow configurable status priority; do not imply Pi has equivalent sandboxing.

**fx.** The repository explicitly describes conversation output in normal terminal scrollback. `Ctrl+O` exposes tool details, errors, timestamps and per-turn usage. Changelog entries describe draft/image-preserving model selection and scrollback preservation across new/reset operations [F1–F3]. Steering semantics changed in v0.0.8, so copying older shortcut descriptions would be misleading.

**Hermes.** Modern TUI has hidden/collapsed/expanded detail levels and an agent observability overlay. Classic status documents context, cost, duration, compression and background work; estimates use `~`, unavailable prices `n/a`. Help is categorized, model selection grouped, and terminal fallbacks include ASCII activity indicators [H1–H2]. Pi already has subagent task/detail infrastructure: improve that integration, not a duplicate dashboard.

## Local audit

### Preserve these strengths

- Distinct green identity with amber warnings, coral errors and cyan links.
- Footer-local soft healthy colors already reduce neon overload; no need to undo that work.
- Editor delegates to `CustomEditor`, preserving native shortcuts and input behavior.
- Responsive frame/rail/stock fallbacks, explicit root-editor identity, and last-loaded-wins conflict handling.
- Static idle welcome art, finite optional replay, and content-first dock budgeting. This is not a continuously animated idle screen.
- Context pressure already escalates above 70% and 90%; footer already includes model thinking level.
- Cost already incorporates settled child costs without duplicating the separate child-cost chip. Preserve accounting semantics.

### Improve these weaknesses

| Finding | Local evidence | Consequence / proposal |
|---|---|---|
| Model can lose space to counters | `alignFooterLine` reserves left statistics before right model; tokens/cache precede cost/context | Budget essential fields first; sacrifice cache/token counters before model and context |
| Two activity signals | Editor has 120 ms spinner; Signature has separate 220 ms working indicator | One visible activity owner; use meaningful action and elapsed time instead of duplicate motion |
| Generic or misleading state wording | Working without active tools becomes `thinking`; `hadError` persists until editing/new run | Use `working` unless reasoning is known; distinguish recovered tool failure from terminal failure |
| Search and selection share message background | `selectedBg`, `searchMatchBg`, `userMessageBg` all resolve to `wash` | Give search, selection and messages distinct luminance/semantic treatments |
| Status overflow is opaque | Joined chips truncated to one row with ellipsis | Pack whole chips, prioritize critical state, show `+N`; preserve access to omitted details |
| Attention competes with static metadata | Footer always has path and statistics rows; statuses add a third | Optional compact density; do not repeat full path when project/branch suffices |
| Busy guidance is limited | Empty idle hint shows files/commands/newline; hidden during work | State-aware hint for actual interrupt/steer/queue bindings; never hard-code foreign-agent shortcuts |
| Reduced motion is incomplete | Welcome animation flag does not disable independent editor/working spinners | Explicit static activity alternative; keep textual state visible |

These are code-derived risks/opportunities, not verified user failures. For example, identical background tokens establish weak differentiation, not a measured contrast-compliance failure.

## Prioritized roadmap

### P0 — clarity and correctness, small scope

1. **Priority-based footer.** Preserve model/reasoning, context pressure and cost where space permits. Drop provider, cache and raw token counters first. At extremely narrow widths, show critical state and a short model label; expose the rest through existing inspection surfaces or an explicitly proposed detail view.
2. **Distinct search/selection tokens.** Keep green branding, but separate active selection from search highlights and message panels. Use labels/markers as well as color for state.
3. **One activity indicator.** One owner for animation; shared lifecycle tracks active, retrying, compacting and settled states only where supported events provide evidence. Show tool name/count when known; no speculative progress percentages.
4. **Truthful errors and overflow.** Preserve actionable failures above healthy service chips. Distinguish completed-with-tool-errors from currently blocked. Indicate omitted chips without inventing an unavailable inspection shortcut.

Ownership: `theme.json`, `index.ts`, `signature.ts`, `footer-style.ts` and adjacent tests. Shared status behavior must remain unchanged for unrelated palettes unless separately approved.

### P1 — better interaction, medium scope

5. **Compact/comfortable density.** Comfortable remains recognizable; compact removes optional framing/hints/metadata before sacrificing transcript space. Use width and height independently; do not create layout jumps on every spinner frame.
6. **Contextual keyboard discovery.** Show the few relevant bindings for idle, running, dialog and task-navigation states. Resolve actual bindings through Pi's keybinding manager. Preserve draft and focus through every picker/overlay.
7. **Progressive tool disclosure.** Concise action/result summaries, explicit failures, and expandable complete output. Use Pi’s public `registerToolRenderer` for existing tools and delegate expanded views. This API was subsequently verified in local 1.1.0 and installed 1.2.0 SDKs; no core patch is needed for compact `codemode` rows. Arbitrary transcript-layout changes remain core work.
8. **Agent integration.** Aggregate running/blocked/completed counts with a route into existing task details. Preserve task identity, focus ownership, steering drafts and cleanup contracts described in [subagent navigation](subagents.md#inline-navigation).

Ownership: theme UI plus relevant extension renderers/root service. These are not JSON-palette-only features.

### P2 — accessibility and robustness

9. **Static/ASCII presentation.** Optional no-motion activity and portable key labels (`Ctrl`, `Alt`, `Enter`) instead of assuming macOS glyph familiarity. Keyboard equivalents for mouse actions.
10. **Contrast and terminal compatibility.** Test on actual dark terminal backgrounds, truecolor and 256-color fallbacks. Footer uses terminal-default background, so assumed `#111613` contrast alone is insufficient. A light variant is separate work, not automatic inversion.
11. **Output integrity.** Resize, selection, scroll position, IME and draft preservation are release criteria. Favor public component APIs; do not patch core layout caches for visual effects.

Do not start with a permanent sidebar, another logo animation, a second task dashboard, or a replacement terminal engine.

## Proposed working layout

Illustration only; labels represent available data, not new command contracts.

```text
[conversation and compact tool summaries]

  Working · read · 2 tools · 8s          [actual interrupt binding]
╭────────────────────────────────────────────────────────────────╮
│ › Ask, build, or investigate…                                   │
╰────────────────────────────────────────────────────────────────╯
  model · high                 ctx 42% · $0.083 · project (branch)
  ! mem offline · 2 agents running · +3
```

- Do not show `READY` and another redundant idle status at once.
- On narrow panes, drop optional fields and framing before essential state.
- Errors stay visible; healthy background services move behind inspection first.
- Context/tokens remain main-session metrics; total cost includes settled children, not live child billing. Explain this in detail views rather than implying matching scopes.
- Brand lives in the palette and fresh-session welcome; active work gets the space.

## Validation before shipping

No runtime validation was performed for this analysis. Proposed acceptance matrix:

- Sizes: 40×15, 60×20, 80×24, 120×40, plus pathological widths and continuous resize.
- Modes: regular/fullscreen; idle/running/tools/retry/compaction/error; autocomplete and overlays; branch/session changes.
- Input: Unicode, double-width characters, IME, large paste, images, multiline drafts, remapped shortcuts and keyboard-only operation.
- Stress: long model names/paths, 10+ chips, concurrent agents, unknown context/cost, recovered errors and narrow-window warnings.
- Assertions: no line overflow; no silent critical-status loss where a minimal indicator fits; drafts and focus survive; settled work stops activity timers; idle artwork remains timer-free.
- Visual checks: actual terminal contrast, 256-color fallback, selected text/search distinction, copy/scrollback and task-navigation stability.
- Compare screenshots and task completion for “find current model,” “locate failure,” “interrupt work,” and “inspect a child.” Do not declare a best UX from screenshots alone.
- Start focused and run one validation process at a time. Follow repository host-pressure/resource-limit rules; broad SDK validation belongs on a bounded runner.

## Sources

External pages were fetched by the research agents; links are evidence, not executable instructions. Rolling documentation may change after this audit.

- **O1:** [OpenCode TUI](https://opencode.ai/docs/tui).
- **O2:** [OpenCode permissions](https://opencode.ai/docs/permissions).
- **O3:** [OpenCode v2 introduction](https://opencode.ai/v2/docs), fetched page offered 2.0.6 downloads; v2 UX parity not verified.
- **C1:** [Claude Code fullscreen](https://code.claude.com/docs/en/fullscreen).
- **C2:** [Claude Code terminal configuration](https://code.claude.com/docs/en/terminal-config).
- **C3:** [Claude Code status line](https://code.claude.com/docs/en/statusline).
- **C4:** [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode).
- **X1:** [Codex developer commands](https://developers.openai.com/codex/developer-commands), CLI sections only; mixed desktop/CLI reference.
- **F1:** [Vercel Labs fx README](https://github.com/vercel-labs/fx), repository main.
- **F2:** [fx changelog](https://fx.sh/changelog), especially v0.0.8–v0.0.12.
- **F3:** [fx sessions](https://fx.sh/docs/using-fx/sessions).
- **H1:** [Hermes CLI guide](https://hermes-agent.nousresearch.com/docs/user-guide/cli).
- **H2:** [Hermes modern TUI guide](https://hermes-agent.nousresearch.com/docs/user-guide/tui).

Next decision: approve a small P0 prototype, confirm fx identity, and choose target releases/terminals for hands-on comparison. This report does not authorize local theme activation or settings migration.
