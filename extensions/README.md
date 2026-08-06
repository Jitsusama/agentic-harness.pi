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
- **Providers** (`*-provider`) contribute to an MCP host over
  the event bus, decorating another server's tools without
  importing its registry.

Packs are the category deliberately not here. A pack is an
extension loaded into a subagent by path rather than discovered,
so it lives under [`packs/`](../packs/): pi scans this directory,
and a pack must not load into the session that dispatched the
subagent.

See [`AGENTS.md`](../AGENTS.md) for what each category commits
to and which extensions are in it.

Each extension has its own README. Domain logic (API clients,
authentication, renderers) lives in the top-level
[`lib/`](../lib/) directory as reusable libraries.
