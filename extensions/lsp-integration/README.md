# lsp-integration

Gives the agent real semantic understanding of the code it
touches through the `lsp` tool: diagnostics, go-to-definition
and find-references from a real language server, rather than
grep-and-hope.

## What It Does

- Registers the standalone backend from core's `lsp`, which
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
- Shares one standalone backend across the runners in a process.
  A runner quitting releases its claim; the last runner closes the
  servers. Relative file paths use the calling session's folder.
- Limits workspace symbol searches to the calling session's folder,
  so another conversation's project does not appear in the answer.
- Starts a sandboxed session's language servers in the sandbox its
  commands run in, since a server runs the project's own code: drawn
  around the session's folder, from the environment its commands get.
  Each fence keeps servers of its own, a search asks only the
  caller's, and a session's servers stop as it ends. A server gets
  no door, SSH agent, clipboard or display, and no variable whose
  name, in either case, marks it a token, key, secret, password, credential, cookie,
  session or socket; one named otherwise still reaches a server in
  the agent fence, while strict passes only what its commands keep.
  A fence that refuses the server, or a server
  that exits inside it, fails the call with the reason. pi reads and
  writes for a fenced server only where the fence lets its own file
  tools, judging the file it opened, and a rename with one file
  refused writes nothing. pi's start lifts the agent fence from all
  but a subagent and a spawn that declared it, on Linux and on a Mac
  alike, so its servers start as an unfenced session's do. On a Mac,
  which has neither fence, a subagent, a first-stage session, a
  strict one and a spawn that declared its fence where pi
  runs in a sandbox or can't tell keep theirs: their servers start
  inside the sandbox pi runs in where there is one, and otherwise
  don't start. The servers' sandbox is drawn at the first call and
  the commands' as the shell loads, so where a busy Mac's trial
  couldn't tell at load but can by that call, its servers may start
  while its commands stay refused. A fenced
  call to servers an older pi started is refused, and they last until
  the host next starts, since a reload never leaves them unheld, or
  until one dies under a call from an unfenced session that runs this
  pi, whose retry starts them afresh in fences. A
  session that runs commands as they are starts its
  servers as before.

## Backend Selection

The tool resolves whichever backend is active rather than the
standalone one directly. The standalone backend registers at
priority 100; when neovim.pi registers its backend below that
and reports itself available for a paired session, the same
tool routes to the editor's own servers with no change to how
it is called.

In a pi-durable host, the registry belongs to each conversation. Editor
registration and removal follow the receiving runner's event bus; they
don't change another conversation's backend, even if the names match.
Direct registry calls accept caller context, or use the host's ambient
session when no caller is supplied. Missing identity is refused rather
than consulting the plain-pi process registry. Plain pi keeps its original
process symbol and existing no-argument calls.

Each hosted runner registers the same standalone pool in its own registry.
A dead connection's replacement is visible to the other runners without
restarting them. Shutdown removes only the caller's standalone registration;
quit also clears that caller's editor registrations, without disposing
servers an external provider owns. The pool closes only after its last
runner releases it.

### Registering an External Backend

Pi loads packages with isolated module roots, so a paired
editor integration cannot import this registry. It registers
over the shared event bus instead:

- `lsp:register-backend` with `{ name, priority, isAvailable,
  backend }` adds the backend. The payload is validated (it
  crosses a trust boundary) and dropped silently if
  malformed. `priority` below 100 wins over the standalone
  default; `isAvailable()` gates when it may serve (e.g. only
  while an editor is paired); `backend` implements the
  `LspBackend` contract from core's `lsp`.
- `lsp:unregister-backend` with `{ name }` removes it.
- On startup this extension emits `lsp:ready` once, so a
  provider that loaded first can re-register on receipt.

This mirrors neovim.pi's own `neovim-pi:register-handler`
bridge, so the handshake is load-order independent.

## Design

An integration in the package taxonomy: the domain logic
(server discovery, lifecycle, the JSON-RPC client, position
translation) lives in core's `lsp`; this extension is the thin
pi-specific wiring. The standalone backend needs a language
server on disk and is TypeScript-first today; provision a
server where you already provision tools (a project
dev-dependency, a devshell, or PATH), and a missing binary
degrades to a clear message.
