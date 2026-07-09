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
[src/app.ts#A1B2]
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
```

## Safety model

This extension intentionally starts smaller than Oh My Pi's native implementation:

- The visible tag is a short **whole-file content tag**, not a per-line hash.
- The session stores full file snapshots and tracks the specific lines shown by `hashline_read`.
- `hashline_edit` rejects edits when:
  - the live file no longer matches the `[path#TAG]` header,
  - an edit anchors to a line that was not shown in the read output,
  - an operation targets a non-existent line.
- Stale-tag recovery and tree-sitter block operations are intentionally left for a later iteration.

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
