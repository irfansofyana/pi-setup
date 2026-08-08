# Terminal Title Pi Extension

Sets terminal title from current Pi session state. Inspired by [Kun's Pi Agent Config](https://blog.kunchenguid.com/p/kuns-pi-agent-config).

Format:

```text
<indicator> | π | <session name or cwd basename>
```

- `○` idle
- Braille spinner while agent works
- `✓` after agent settles
- `✗` reserved for error state
- Session names override cwd basename; titles truncate at 40 characters.

`session_info_changed` refreshes title after `/name` changes session label.

## Install

From repository root, use canonical private backup-and-replace procedure in [setup installation guide](../../../docs/setup/installation.md#install-local-templates).

Then run:

```text
/reload
```

`pi-signature.ts` owns header and footer. This extension owns terminal title; deploy both current templates to avoid competing `ctx.ui.setTitle()` calls.

## Test

```bash
node --test pi/extensions/terminal-title/*.test.ts
```
