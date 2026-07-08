# lsp-integration

Gives the agent real semantic understanding of the code it
touches through the `lsp` tool: diagnostics, go-to-definition
and find-references from a real language server, rather than
grep-and-hope.

## What it does

- Registers the standalone backend from `lib/lsp`, which
  spawns and supervises language servers itself, keyed one
  per resolved project root.
- Exposes the `lsp` tool. `operation=diagnostics` reports a
  file's problems; `operation=definition` and
  `operation=references` answer position queries. Positions
  are a 1-indexed line and a 0-indexed byte column, the same
  coordinates read and grep report. No slash command; the
  agent calls the tool when a task needs it.
- Keeps the servers current with pi's own edits: on an edit
  or write tool result it re-syncs the document, so
  diagnostics reflect the bytes on disk rather than the bytes
  at open.
- Disposes every server at session shutdown, so nothing
  leaks.

## Backend selection

The tool resolves whichever backend is active rather than the
standalone one directly. The standalone backend registers at
priority 100; when neovim.pi registers its backend below that
and reports itself available for a paired session, the same
tool routes to the editor's own servers with no change to how
it is called.

## Design

An integration in the package taxonomy: the domain logic
(server discovery, lifecycle, the JSON-RPC client, position
translation) lives in `lib/lsp`; this extension is the thin
pi-specific wiring. The standalone backend needs a language
server on disk and is TypeScript-first today; provision a
server where you already provision tools (a project
dev-dependency, a devshell, or PATH), and a missing binary
degrades to a clear message.
