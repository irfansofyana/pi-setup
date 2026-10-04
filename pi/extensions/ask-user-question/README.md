# Ask user question

Original package-owned questionnaire UI, inspired by Claude Code's structured choices—not a source copy or exact clone. Research and primary-source citations: [findings](../../../docs/setup/ask-user-question-research.md).

## Interface

`ask_user_question` keeps the existing tool name and input fields:

```json
{
  "questions": [{
    "header": "Storage",
    "question": "Which storage should we use?",
    "options": [
      { "label": "Files (Recommended)", "description": "Easy to inspect and version." },
      { "label": "Database", "description": "Flexible queries and concurrent writes." }
    ],
    "multiSelect": false
  }]
}
```

- 1–4 questions; 2–4 distinct authored options each.
- Header: 16 characters maximum. Label: 60. Question/description: 500. These are Pi compatibility/local limits, not claims about Claude's limits.
- Optional `preview`: plain text/code, up to 8000 characters; single-select only. No HTML execution, external links fetched, or subprocesses.
- Automatic **Type something.** row on every question; custom answer up to 4000 characters. Do not author `Other`, `Type something.`, or `Next` labels.
- Recommendations are label suffixes, never preselected answers.
- Multi-select permits selected labels plus optional custom details. Single-select custom text replaces option selection.
- Every question must be answered; final review precedes submission. Empty answers are not consent.

## Terminal flow

- Arrows move focus. Numbers 1–4 or Space select/toggle while browsing.
- Single-select Enter chooses the focused option and advances; multi-select Space toggles, then Enter advances.
- Focus **Type something.** to type; numeric keys belong to text input there. Custom entry always spans the full pane.
- Tab/Shift+Tab revisits questions without losing drafts. Review: Enter submits, Shift+Tab edits.
- Esc or Ctrl+C cancels the **whole** questionnaire; partial drafts are not returned as answers.
- Previews sit beside choices at 88+ columns, stack below on narrow terminals. PgUp/PgDn scroll previews or review; Ctrl+Up/Down scroll long questions/descriptions/review. Progress and footer stay visible.
- Width helpers preserve Unicode columns. Focus propagates to Pi's native Input for cursor/IME support; theme colors use injected active theme.

## Modes and lifecycle

TUI uses `ctx.ui.custom()`. RPC uses supported native `select`/`input` dialogs, repeated selection for multi-select, plain-text previews, and final review. It never writes raw text to RPC stdout. RPC custom answers can be replaced by reopening **Type something.** before finishing multi-select; no question-tab editing in this fallback. Terminal control sequences are stripped from custom answers before rendering/storage, including bracketed paste.

Print/JSON/no-UI modes throw an explicit unavailable error; ask in chat instead. Abort or session shutdown closes the interaction and returns `status: "aborted"`, `cancelled: true`, `answers: []`. Esc/RPC dismissal returns `status: "cancelled"` with the same empty answer list. Concurrent questionnaires are rejected rather than sharing focus.

Submitted results contain `status: "answered"`, `cancelled: false`, and `answers` with `questionIndex`, `question`, `header`, `kind`, `answer`, `selected`, and `customText`. `selected` preserves option order; `answer` is readable text, not a delimiter-safe machine format. Read `selected` and `customText` for programmatic use.

Historical `{ answers, cancelled }` questionnaire results remain readable, including array-valued multi-select answers. Their stored data is not rewritten.

No config, task files, telemetry, network calls, or package dependencies. Answers appear in ordinary Pi tool results/session history: **never request passwords, tokens, or other secrets**. This is a preference/clarification UI, not an execution-approval gate or sandbox.

## Migration and smoke

Structured questions ship directly with this package; no separate question-tool package is needed. Installation does not remove duplicate sources, migrate configuration, or change local settings. Review conflicting extension sources and remove only approved duplicates. Legacy collapse shortcuts, localization, and external-editor configuration are not migrated.

After loading the updated package, run `/reload`, then `/ask-demo`. Try preview switching, custom text, multi-select, question navigation, final review, and cancellation. Demo does not send a model prompt or write state files.

```bash
node --test pi/extensions/ask-user-question/*.test.ts
```

Tests cover validation, real key sequences, width/Unicode/focus, previews, scrollable review, paste sanitization, resize cursor visibility, historical results, cancellation/abort, RPC/no-UI, busy guard, and shutdown. Real Pi 1.0.2 PTY smoke passed in fullscreen and regular modes (120 columns resized to 45), using an offline temporary Pi home and no model calls. Native loader and strict runtime type-check against Pi 1.0.2 declarations also passed. Check your terminal's own key protocol and IME behavior with `/ask-demo`.
