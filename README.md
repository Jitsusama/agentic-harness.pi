# agentic-harness.pi

A [pi](https://github.com/badlogic/pi-mono) package that adds
collaborative coding workflows — planning, TDD, git hygiene,
code investigation, and PR authoring.

## Install

```bash
pi install git:github.com/Jitsusama/agentic-harness.pi
```

Or try it without installing:

```bash
pi -e git:github.com/Jitsusama/agentic-harness.pi
```

## How It Works

This package has two layers:

**[Skills](skills/)** teach the agent *how* to work — planning
methodology, TDD discipline, commit conventions, and so on. They're
guidance the agent follows voluntarily when a task matches.

**[Extensions](extensions/)** enforce *guardrails* — gating commits
for review, restricting tools in read-only mode, enforcing TDD
phases, and vetting PR comments before they're posted.

Skills and extensions complement each other but work independently.
You can use skills without extensions (guidance only), extensions
without skills (enforcement only), or both together for the full
workflow.

### AGENTS.md

A minimal collaboration style guide that's always in context.
Tells the agent to explain findings, pause before big changes,
research before acting, get approval on all commits, and ask
when requirements are ambiguous.

## Composability

Every piece works independently. Mix and match:

- **Skills only** — the agent follows guidance voluntarily
- **Git-guardian only** — commit review without any skills
- **Plan-mode only** — read-only enforcement without TDD
- **TDD-mode only** — phase enforcement without planning
- **Everything** — plan → TDD → commit flows seamlessly

Use [package filtering](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#package-filtering)
to load only what you want:

```json
{
  "packages": [
    {
      "source": "git:github.com/Jitsusama/agentic-harness.pi",
      "extensions": ["extensions/git-guardian", "extensions/tdd-mode"],
      "skills": ["skills/tdd-workflow", "skills/conventional-commits"]
    }
  ]
}
```

## Project-Local Overrides

Each project can layer on its own configuration via `.pi/`:

```markdown
<!-- .pi/AGENTS.md -->
Test command: `cargo test`
Commit scopes for this project: api, cli, core, db
```

```json
// .pi/settings.json
{ "planDir": "docs/plans" }
```

## License

[MIT](LICENSE)
