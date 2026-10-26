# Library

Reusable TypeScript code for Pi extensions, in three layers by who
may import it, plus [`core/`](core/), the code of
[agentic-harness.core][core] folded in as it was. A module here that
only re-exports core says so in its `index.ts`, and stays so that
what consumers import keeps working.

## Public Modules

What another Pi package may import, and nothing else: each is a path
under `exports` in [`package.json`](../package.json), and its
`index.ts` barrel is the whole of its surface. Import from the
barrel, never from a file behind it.

- **[`clock/`](clock/)**: what a duration bounding a child process
  may be. The rules belong to the runner, but a roster read from a
  config file needs them first, so one definition serves both.
- **[`command/`](command/)**: a lossless, range-indexed model of a
  command line, a flag-spec layer and splice-by-range editing.
- **[`compaction/`](compaction/)**: when compacting pays, the
  contract a summary provider registers over the bus, and how a
  summary is asked for, sized and spliced in.
- **[`glossary/`](glossary/)**: whether a name says core.nix's
  glossary's words or a name it replaces, the matcher every
  repository holds its names to.
- **[`google/`](google/)**: Google Workspace clients, renderers and
  types, with `google/auth` for the interactive sign-in.
- **[`guardian/`](guardian/)**: the guardian contract,
  registration, the guard policy and reports.
- **[`jobs/`](jobs/)**: the seam between work that runs on after
  its tool returns and the host that says its result.
- **[`mcp/`](mcp/)**: a server-agnostic MCP client mapping a
  server's tools onto pi's, with seams for server-specific
  behaviour.
- **[`people/`](people/)**: handle types, the person-resolver chain
  and identity types.
- **[`prompt/`](prompt/)**: the resident system prompt, frozen once
  per session, and standing context said as messages when it
  changes.
- **[`quest/`](quest/)**: the quest data model: ids, frontmatter,
  scaffolding and URL hints.
- **[`refs/`](refs/)**: a registry of reference types (an issue, a
  pull request, a Slack thread) found in text and turned into URLs.
- **[`shell/`](shell/)**: shell command parsing: flags, heredocs,
  splitting and quoting.
- **[`slack/`](slack/)**: the Slack client, renderers and
  resolvers, with `slack/auth` for the interactive sign-in.
- **[`subagent/`](subagent/)**: running pi as a child process:
  jobs, fleets, supervised runs, stream parsing and verify packs.
- **[`terminal/`](terminal/)**: opening shells in a window, tab or
  pane of the person's terminal, and typing into them.
- **[`ui/`](ui/)**: TUI primitives: panels, prompts, content
  rendering, navigable lists and text layout.

## Shared Modules

These are shared by several extensions here, but `package.json`
doesn't export them, so another package can't import them. Promoting
one is adding it to `exports`, which makes its barrel a commitment.
Two have no barrel yet, and are imported file by file.

- **[`classifier/`](classifier/)**: finding a classifier model in
  the session's registry; every caller works without one. No
  barrel.
- **[`completion/`](completion/)**: one completion against a model,
  off the agent's own loop.
- **[`gate/`](gate/)**: what a prose or Slack gate does with the
  violations it found, remembered by signature for the session.
- **[`ledger/`](ledger/)**: reading pi's session logs into billable
  turns, for the cost and observability workflows.
- **[`memory/`](memory/)**: quest-scoped durable facts.
- **[`mesh/`](mesh/)**: the mesh between sessions on a machine:
  addresses, groups, messages and leases. No barrel.
- **[`prose/`](prose/)**: finding prose-standard violations,
  wrapping and the prose gate's decision.
- **[`roles/`](roles/)**: which of a provider's models are premium,
  primary, light or archaic.
- **[`thinking/`](thinking/)**: the thinking levels pi accepts,
  written down once for the review and subagent sides.
- **[`verification/`](verification/)**: which check the
  verification loop runs and what to do with its errors.

## Internal Modules

[`internal/`](internal/) holds code for this package's extensions
alone, with no barrels; its [README](internal/README.md) says what
each part is for. Nothing outside the package may import it, and it
changes without notice.

## Core

[`core/`](core/) is agentic-harness.core's code, brought in whole
so that one package holds the harness; its
[README](core/README.md) says how it is laid out and what comes
next. Extensions import it by relative path, like any module here.

[core]: https://github.com/Jitsusama/agentic-harness.core
