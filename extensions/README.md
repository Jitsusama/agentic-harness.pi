# Extensions

Extensions enforce guardrails and orchestrate workflows around
the agent's actions. Where [skills](../skills/) teach the agent
what to do, extensions gate, validate and implement what actually
happens.

They fall into five categories:

- **Guardians** (`*-guardian`) intercept and gate commands
  before execution: approve, edit, steer or reject.
- **Interceptors** (`*-interceptor`) silently modify commands
  before execution.
- **Workflows** (`*-workflow`) orchestrate multi-step or
  session-wide processes with state and stages.
- **Integrations** (`*-integration`) bridge to external
  services.
- **Widgets** (`*-widget`) add UI elements to the interface.

Each extension has its own README. Domain logic (API clients,
authentication, renderers) lives in the top-level
[`lib/`](../lib/) directory as reusable libraries.
