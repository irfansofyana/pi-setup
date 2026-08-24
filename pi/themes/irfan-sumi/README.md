# Irfan Sumi Theme UI

Package-owned `irfan-sumi` theme bundle:

- `theme.json`: ink-black, warm-neutral, and amber color tokens
- `index.ts`: compact borderless editor, placeholder, state labels, spinner, scroll indicators, hints, and narrow-terminal fallback
- `smoke-test.mjs`: theme/editor lifecycle and collision coverage

Pi loads theme JSON and TypeScript extensions through separate manifest fields, so both files remain distinct resources inside this one theme directory. The editor activates only when `irfan-sumi` is selected at session start. Run `/reload` after switching themes.

Pi has one custom-editor slot. Irfan Sumi warns when another extension also claims it, but does not forcefully reclaim the slot; Pi's normal last-loaded-editor behavior remains. Theme selection stays independent, so Sumi colors and Pi Signature remain active if another editor wins. Autocomplete-only extensions should use `ctx.ui.addAutocompleteProvider(...)` instead of replacing the editor.

Requires Pi `>=0.84.1`. Pi supplies `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`; no extra runtime package is required.

Irfan Sumi loads from the first-party Pi package described in the [setup installation guide](../../../docs/setup/installation.md#install-the-package). Run `/reload` after package installation or update.
