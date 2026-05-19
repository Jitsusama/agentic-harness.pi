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
  via the `neovim-pi` extension, pi opens `pi://` buffers for
  diffs and source files. Unpaired sessions fall back to
  inline diff rendering for context only; substantive viewing
  needs nvim.
- **Stack-aware.** When the active PR is part of a stack, the
  council reasons across the whole stack, and post gates lay
  out the order of operations explicitly.
- **Fix loop in the MVP.** "Address this and commit it" is a
  first-class flow, not a follow-up feature.
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
  GitHub, fetches and parses the per-file diff, and
  surfaces a one-screen summary (title, author, state,
  base/head, diffstat, URL, file list with per-file change
  counts). The diff fetch is best-effort: if it fails, the
  workflow stays loaded with metadata only and reports the
  diff error.

Every other capability — council, findings, post, fix
loop, stack overview, neovim companion wiring — lands in
follow-up commits, each gated by tests.

## Files

- `state.ts` — runtime state for the session (active PR,
  findings, council, companion linkage). Grows as
  capabilities land.
- `load.ts` — parses a PR reference and engages the
  session. Pure; no network calls.
- `fetch.ts` — fetches PR metadata via `gh api graphql`.
  Splits the wire boundary: `parsePrMetadata` is a pure
  parser; `fetchPrMetadata` is a thin orchestrator.
- `index.ts` — extension registration. Reads as a table of
  contents.

Subsequent capabilities live in their own subdirectories
(e.g. `council/`, `findings/`, `companion/`, `post/`) and are
wired into `index.ts` via named imports.

## Tests

`tests/extensions/pr-workflow/` covers the state factory.
Each new capability ships its own tests at the same depth.
