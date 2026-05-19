# pr-workflow

Conversation-first pull request review and reply, built on
pi's TUI primitives and the neovim-pi companion protocol.

## What This Replaces

This extension supersedes the three earlier PR extensions:

- `pr-review-workflow` — multi-step review of someone else's PR
- `pr-reply-workflow` — addressing review feedback on your own PR
- `pr-annotate-workflow` — inline self-review comments on a PR

The earlier extensions split a single workflow (the PR
lifecycle) across three task-scoped state machines, each with
its own panels, gates and rituals. The redesign collapses
them into a single conversation: the user prompts in prose,
the agent calls `pr_workflow`, and the extension grows panels,
narration and findings around the conversation rather than
steering it from a menu.

## Design Principles

- **Conversation is the surface.** No top-level menus. Tools
  exist for the agent to call; panels exist for the agent to
  show specific artifacts (findings list, diff view, council
  status). The user always drives by prompt.
- **Multi-model review council.** Findings are produced by
  parallel calls to several models, then reduced through a
  judge round, surfaced to the user, and posted on approval.
  Council mechanics live in `extensions/pr-workflow/council/`
  once that capability scaffolds.
- **Neovim is the code viewer.** When paired with a neovim
  via the `neovim-pi` extension, the agent can call
  `nvim_buffer_open` with `pi://pr/.../file/<sha>/<path>`
  URIs to view PR files in nvim. Unpaired sessions fall
  back to inline diff rendering for context only;
  substantive viewing needs nvim.
- **Stack-aware.** When the active PR is part of a stack, the
  council reasons across the whole stack, and post gates lay
  out the order of operations explicitly.
- **Self-applied fixes.** Findings the user wants to handle
  themselves get verdicted `fix` and stay out of the posted
  review. The main agent (or the user) does the edit in
  the real checkout when ready; the worktree is
  research-only.
- **No global keymaps or autocmds.** Nothing in nvim is
  hijacked by default. Pi steers nvim via the documented
  companion protocol; the user always wins.

## Status

Early scaffold. The extension registers a single
`pr_workflow` tool with two actions:

- `pr_workflow(action="status")` — returns the current
  workflow state. Useful for diagnostics and for confirming
  the extension is loaded.
- `pr_workflow(action="load", pr=<ref>)` — parses a PR
  reference (full URL, owner/repo#number short form, or
  bare number with repo defaults), fetches metadata from
  GitHub, fetches and parses the per-file diff, walks the
  base/head chain to detect a PR stack and surfaces a
  one-screen summary: title, author, state, base/head,
  diffstat, URL, stack chain (when present, with the
  cursor marked), fan-out children (when the cursor has
  more than one child) and the file list. Diff and stack
  fetches are best-effort: if either fails, the workflow
  stays loaded with whatever succeeded and reports what
  didn't.

Every other capability — council, findings, post, stack
overview, neovim companion wiring — lands in follow-up
commits, each gated by tests.

## Sibling Extensions

- [`pr-workflow-verify`](../pr-workflow-verify/) registers
  a `verify_output` tool that reviewer subagents call to
  self-validate their JSON against the same TypeBox
  schemas the parent will parse against. The parent
  resolves this extension's absolute path (via
  `verify-path.ts`) and injects it into every reviewer
  subagent through `pi --extension <path>`. Schemas live
  in [`schemas.ts`](./schemas.ts) and are the single
  source of truth for both sides.

## Files

- `state.ts` — runtime state for the session (active PR,
  findings, council, companion linkage). Grows as
  capabilities land.
- `load.ts` — parses a PR reference and engages the
  session. Pure; no network calls.
- `fetch.ts` — fetches PR metadata via `gh api graphql`.
  Splits the wire boundary: `parsePrMetadata` is a pure
  parser; `fetchPrMetadata` is a thin orchestrator.
- `stack.ts` — walks a PR's base/head chain to discover
  the stack it belongs to. The walker depends on a
  `PrSearch` interface so it stays pure and testable.
- `search.ts` — GitHub-backed `PrSearch` factory. Runs one
  GraphQL query per neighbour lookup; the walker calls it
  at most `maxDepth * 2` times per discovery.
- `buffer.ts` — `pi://pr/...` URI scheme: parser, builder,
  resolver and filetype inference. All pure; the file
  fetcher is injected.

## `pi://pr` URI Scheme

The extension defines one URI shape today:

```
pi://pr/<owner>/<repo>/<number>/file/<sha>/<path>
```

The SHA is baked into the URI so the resolver is
self-contained and doesn't depend on workflow state.
Re-loading the PR generates fresh URIs against the new
head; existing URIs continue to resolve at the SHA they
name.

On startup the extension emits a
`neovim-pi:register-handler` event asking neovim-pi to
route `buffer.uri.resolve` calls through its handler.
It also subscribes to `neovim-pi:ready` and re-emits on
receipt so the handshake works regardless of which side
loaded first. The cross-package contract is documented
in neovim.pi's `doc/protocol.md`.

When neovim-pi is absent (not installed, or doesn't
speak this contract), both emits are no-ops and
`pi://pr/...` URIs won't open in nvim. The agent can
still construct URIs for use once a paired session is
available.
- `index.ts` — extension registration. Reads as a table of
  contents.

Subsequent capabilities live in their own subdirectories
(e.g. `council/`, `findings/`, `companion/`, `post/`) and are
wired into `index.ts` via named imports.

## Tests

`tests/extensions/pr-workflow/` covers the state factory.
Each new capability ships its own tests at the same depth.
