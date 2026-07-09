# Local Hashline Pi extension

Hashline-inspired read/edit tools for stock Pi, modeled after the useful parts of Oh My Pi's hashline flow without forking Pi.

## What it adds

Tools:

```text
hashline_read   # read a file with [path#TAG] header and numbered lines
hashline_edit   # apply a tagged SWAP/DEL/INS patch
```

Command:

```text
/hashline status
/hashline clear
```

## Patch format

Read first:

```text
hashline_read({ "path": "src/app.ts", "startLine": 10, "endLine": 30 })
```

Then edit using the exact header:

```text
[src/app.ts#A1B2C3D4E5F6]
SWAP 12.=14:
+replacement line 1
+replacement line 2
INS.POST 20:
+inserted after line 20
DEL 25.=27
```

Supported operations:

```text
SWAP N.=M:       replace inclusive line range with + payload rows
DEL N           delete one line
DEL N.=M        delete inclusive line range
INS.PRE N:      insert + payload rows before line N
INS.POST N:     insert + payload rows after line N
INS.HEAD:       insert at start of file
INS.TAIL:       insert at end of file
SWAP.BLK N:     replace the brace/indent block starting at line N
DEL.BLK N       delete the brace/indent block starting at line N
INS.BLK.POST N: insert after the brace/indent block starting at line N
```

## Safety model

This extension intentionally starts smaller than Oh My Pi's native implementation:

- The visible tag is a 12-hex **whole-file content tag**, not a per-line hash.
- The session stores full file snapshots and tracks the specific lines shown by `hashline_read`.
- `hashline_edit` rejects edits when:
  - the tag was not minted in the current hashline session,
  - the live file no longer matches the `[path#TAG]` header and cannot be safely remapped,
  - an edit anchors to a line that was not shown in the read output,
  - an operation targets a non-existent line.
- Writes preserve the input file's UTF-8 BOM and dominant line ending (`LF` or `CRLF`).
- Multi-section patches are preflighted before any write or snapshot update happens, so a stale second file cannot leave the first file half-applied or poison the session cache.
- Duplicate sections targeting the same file are rejected; merge operations under one `[path#TAG]` header.
- Relative and absolute paths are confined to the current project root.
- Stale tags are recovered only when every anchor maps through unchanged lines with one consistent offset; changed anchors still reject.
- Block operations resolve simple brace-delimited and indentation-delimited blocks and emit a heuristic warning. This is not a full tree-sitter resolver yet; use explicit ranges when precision matters.
- After `hashline_edit`, the extension appends diagnostics from a best-effort Pi context LSP hook when available (`ctx.lsp.diagnostics`, `ctx.lsp.getDiagnostics`, or compatible function shape).

## Operational notes

- This is opt-in: it adds `hashline_read` and `hashline_edit`; it does not replace Pi's built-in `read`, `edit`, `write`, or search tools.
- Snapshots are in memory only, keep the latest 4 versions per path by default, and are cleared on Pi restart/reload or `/hashline clear`.
- Files larger than 4 MiB are rejected by `hashline_read` to avoid large in-memory snapshots.
- Relative paths resolve from the current Pi project root; absolute paths are allowed only when they stay inside that root.
- Recommended permission policy: allow `hashline_read`, ask for `hashline_edit`.
- `/hashline status` shows read/edit counts; `/hashline clear` clears the snapshot cache.

## Install

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi/extensions/hashline ~/.pi/agent/extensions/
```

Reload Pi:

```text
/reload
```

## Tests

From this repo:

```bash
node --test pi/extensions/hashline/index.test.ts
```
