# Extensions

Extensions enforce guardrails and orchestrate workflows around
the agent's actions. Where [skills](../skills/) teach the agent
what to do, extensions gate, validate and implement what actually
happens.

They fall into six categories:

- **Guardians** (`*-guardian`) intercept and gate commands
  before execution: approve, edit, steer or reject.
- **Interceptors** (`*-interceptor`) silently modify commands
  before execution.
- **Workflows** (`*-workflow`) orchestrate multi-step or
  session-wide processes with state and stages.
- **Integrations** (`*-integration`) bridge to external
  services.
- **Widgets** (`*-widget`) add UI elements to the interface.
- **Providers** (`*-provider`) contribute to a host over the
  event bus without importing its registry: decorating an MCP
  server's tools, or writing or adding to compaction summaries.

Many entries because each extension is a folder straight under this
one, and its suffix is its grouping. pi looks only one folder down a
package's listed folder, for each subfolder's `index.ts`, so a folder
per category would have to be named in `package.json`, and so would
every path that names an extension today: the tests' mirror, the host
gate, the fixtures that link one in, and any setting that names one by
path. A category folder would only repeat the suffix that 63 of the
66 names already end in; `advisor`, `convention-context` and
`correction-capture` have none.

Packs are the category deliberately not here. A pack is an
extension loaded into a subagent by path rather than discovered,
so it lives under [`packs/`](../packs/): pi scans this directory,
and a pack must not load into the session that dispatched the
subagent.

See [`docs/extensions.md`](../docs/extensions.md) for what each
category commits to and which extensions are in it.

Each extension has its own README. Domain logic (API clients,
authentication, renderers) lives in the top-level
[`lib/`](../lib/) directory as reusable libraries.
