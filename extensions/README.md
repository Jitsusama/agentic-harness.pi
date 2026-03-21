# Extensions

Extensions enforce guardrails around the agent's actions. Where
[skills](../skills/) teach the agent what to do, extensions gate
and validate what actually happens.

They fall into four categories:

- **Guardians** intercept and gate actions before execution:
  approve, edit, steer or reject.
- **Modes** enforce stateful workflows, toggled on and off.
- **Tools** register new agent capabilities.
- **UI** components display information.

Each extension has its own README. The [lib](lib/) directory
holds the common components they share.
