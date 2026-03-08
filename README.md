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

## What's Inside

### Extensions

| Extension | What it does |
|-----------|-------------|
| **git-guardian** | Reviews every commit and gates destructive git commands (force push, reset --hard, etc.) |
| **ask** | Structured question tool the agent uses for clarifying requirements |
| **pr-review** | Proposes inline PR review comments for you to vet before posting |
| **plan-mode** | Read-only investigation mode — no code changes until you leave |
| **tdd-mode** | Red → green → refactor state machine with phase enforcement |

### Skills

| Skill | Activates when... |
|-------|-------------------|
| **planning** | Designing or architecting before building |
| **tdd-workflow** | Implementing features with tests |
| **conventional-commits** | Writing commit messages |
| **git-hygiene** | Discussing commit strategy or history |
| **branch-management** | Creating branches, switching, moving commits |
| **pr-writing** | Creating pull requests or writing PR descriptions |
| **code-investigation** | Understanding existing code |
| **rebase-resolution** | Rebasing or resolving merge conflicts |
| **github-sub-issues** | Managing parent/child issue relationships |
| **github-projects** | Working with GitHub Projects v2 boards |

### AGENTS.md

A minimal collaboration style guide that's always in context.
Tells the agent to explain findings, pause before big changes,
research before acting, get approval on all commits, and ask
when requirements are ambiguous.

## Usage

### Planning

Say "let's plan this out" and the agent investigates before
proposing anything. Use `/plan` or `Ctrl+Alt+P` if you want
read-only enforcement — no code modifications until you
transition out.

Plans are written to `.pi/plans/` by default. Override with
`/plan-dir <path>` or in `.pi/settings.json`:

```json
{ "planDir": "docs/plans" }
```

After the plan is written, you choose: TDD, free-form, or
stay in planning.

### TDD

Say "let's TDD this" or use `/tdd` (`Ctrl+Alt+T`) for phase
enforcement. Point it at a plan with `/tdd .pi/plans/my-plan.md`.

The state machine tracks red → green → refactor. During the red
phase, writes to implementation files require confirmation (test
files are unrestricted). After each green, a refactor gate pauses
for your input. After refactor, a commit is proposed and reviewed
by git-guardian.

### Committing

Git-guardian intercepts every commit for review, showing validation
indicators (subject length, body wrap, conventional format). You
approve, steer, edit, or reject.

Destructive git commands get a similar gate: allow, steer, or block.

### Pull Requests

The agent writes PR descriptions following the pr-writing skill's
structure, then uses pr-review to propose inline self-review
comments. You vet each comment before it's posted to GitHub.

### Research

Ask the agent to help you understand code. The code-investigation
skill guides it to investigate thoroughly and present focused
summaries rather than raw dumps.

## Composability

Every piece works independently. Skills guide behavior, extensions
enforce it. Mix and match:

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

## Quick Reference

### Commands

| Command | Description |
|---------|-------------|
| `/plan` | Toggle plan mode |
| `/plan-dir [path]` | Show or set plan directory |
| `/tdd [plan-file]` | Toggle TDD mode |

### Keyboard Shortcuts

| Shortcut | Description |
|----------|-------------|
| `Ctrl+Alt+P` | Toggle plan mode |
| `Ctrl+Alt+T` | Toggle TDD mode |

## License

[MIT](LICENSE)
