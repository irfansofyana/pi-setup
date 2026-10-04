# Package-owned `ask_user_question`: research and design

Researched 2026-10-04. Findings inform the repository-owned implementation; no local activation or configuration cleanup is authorized by this document.

## Recommendation

Build an original Pi questionnaire inspired by Claude Code's structured choices, not an exact clone. Use Pi's host-provided TUI components and native RPC dialogs, with no external runtime dependencies. The [component README](../../pi/extensions/ask-user-question/README.md) owns the implemented API and behavior.

## Primary-source findings

| Topic | Confirmed evidence | Implementation implication |
| --- | --- | --- |
| Limits | Official Agent SDK docs specify 1–4 questions, 2–4 options each, and headers up to **12** characters. [1] | Keep existing Pi **16**-character headers as a local compatibility choice, not a Claude specification. |
| Shape | Official TypeScript input exposes `question`, `header`, option `label`/`description`/optional `preview`, and `multiSelect`. Numeric bounds are not expressed in the displayed type. [2] | Validate counts and lengths explicitly. |
| Custom answers | Official docs instruct hosts to append an “Other” choice and return the user's text, not the label “Other”. [1] | Always offer custom text; **Type something.** is our UI wording. |
| Multi-select | Official docs support `multiSelect: true` and answer examples using label arrays or comma-joined labels. [1] | Return selected labels as an array; do not parse delimiters. |
| Previews | The SDK supports optional `markdown` or `html` preview formats; HTML excludes scripts, styles, and document declarations. [1] | Our terminal implementation uses plain text/code, with no HTML execution. |
| Recommendations | Official input type has no recommendation field. [2] | First option plus `(Recommended)` suffix is a local convention, never a preselected answer. |
| Cancellation | SDK callbacks receive an `AbortSignal`; dismissed cards can also produce a freeform response. [1] | Report abort/cancellation explicitly. Exact Claude CLI Esc payload is not confirmed. |
| Pi modes | Custom terminal components require `ctx.mode === "tui"`; RPC has UI support but `custom()` returns `undefined`. Native dialogs use request/response IDs. [3] | Use native `select`/`input` in RPC, not custom terminal UI. |
| Pi cancellation | Dismissed RPC select/input/editor dialogs return `undefined`; confirm returns `false`. [3] | Dismissal must not become a choice or approval. |

Checked official passages include “Short label for the question (max 12 characters)”, “each `AskUserQuestion` call supports 1-4 questions with 2-4 options each”, and “Use the user's custom text as the answer value (not the word ‘Other’)”. [1]

## Local design choices

- Preserve Pi input fields: `questions`, `question`, `header`, `options`, `label`, `description`, `preview`, and `multiSelect`.
- Require 1–4 distinct questions and 2–4 distinct options per question. Header limit: 16; label: 60; question/description: 500; preview: 8000 characters.
- Append custom answers internally; reject authored `Other`, `Type something.`, and `Next` navigation rows. Custom answers allow up to 4000 characters.
- Previews are single-select only. This restriction is local, not a verified Claude requirement.
- Single-select custom text replaces selected choices. Multi-select explicitly permits choices plus custom details.
- Final review requires every question answered. Esc/RPC dismissal cancels the whole questionnaire without returning partial drafts.
- Keep state local to one invocation. No configuration files, network requests, telemetry, subprocesses, or persistent extension-owned state.
- Submitted answers appear in ordinary session tool results; never request secrets. This is not a permission gate or sandbox.

## Terminal and RPC flow

- **TUI:** native custom component, numbered choices with visible descriptions, question progress, custom input, and final review. Arrows/numbers choose; Space toggles multi-select; Enter advances; Tab/Shift+Tab revisits; Esc cancels.
- **Custom entry:** full-width native Input with propagated cursor/IME focus. Numeric keys belong to text entry while focused. Sanitize terminal controls before rendering or storage.
- **Previews:** side-by-side at sufficient width, stacked on narrow terminals. Use Pi width helpers, active theme, bounded preview height, and scrolling. [4]
- **Long content:** scroll complete questions, descriptions, and review; keep progress/footer visible. Recalculate focused cursor visibility after resizing.
- **RPC:** repeated native select dialogs, custom input, explicit Done for multi-select, and final review. Include plain-text previews; reject unknown response values.
- **No UI:** print/JSON/headless modes fail clearly; no stdin blocking or fabricated answers.
- **Lifecycle:** serialize questionnaires, reject overlapping dialogs, and support tool abort/session shutdown. Cancellation is never approval.

## Implemented result and compatibility

The runtime under `pi/extensions/ask-user-question/` returns `status`, `cancelled`, and an `answers` array. Each answer includes `questionIndex`, `question`, `header`, `kind`, `answer`, `selected`, and `customText`.

Historical `{ answers, cancelled }` questionnaire results remain readable, including array-valued answers and unanswered records. Stored history is not rewritten. Programmatic callers should use `selected` and `customText`, not split readable `answer` text.

## Verification and evidence limits

Official pages are live documentation reviewed on the research date. Exact Claude CLI keyboard behavior, recommendation wording, cancellation payload, and preview/multi-select restrictions were not confirmed. SDK host integration does not imply identical CLI rendering.

Important claims rely on fetched source bodies, not search snippets. Public search/extraction and source retrieval were used; direct official-site fetch returned HTTP 403, so an alternate public extraction path supplied the user-input page. No local user settings or secrets were read or stored.

Regression tests cover input limits, custom answers, multi-select, previews, Unicode widths, complete review scrolling, paste sanitization, resize cursor visibility, historical results, cancellation/abort, RPC/no-UI, and malformed responses.

Strict runtime type-check and native loader passed against Pi 1.0.2. Real fullscreen/regular PTY smoke passed offline in a temporary Pi home: previews, multi-select, custom entry, review/edit/submit, narrow resize, and cancellation. No model call or local package/settings activation occurred. Check device-specific terminal/IME behavior with `/ask-demo` after loading the updated package and `/reload`.

## Sources

1. [Official Claude Agent SDK: Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input) — limits, custom text, previews, callback cancellation, response formats.
2. [Official Claude Agent SDK TypeScript reference: AskUserQuestion](https://code.claude.com/docs/en/agent-sdk/typescript#askuserquestion) — input fields; no recommendation field.
3. [Official Pi RPC Extension UI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md) — fetched public source; Git blob `bd489450d3b30c00194b9f4a58043e69d34f0994`.
4. [Official Pi Terminal UI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md) — fetched public source; Git blob `4a2ff2c56cc7c9a22d8677b7d5d7ae454e36fc86`.
