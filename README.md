# pi-setup

Collaborative coding workflows for pi: planning, TDD, git hygiene,
and code investigation.

## Install

```bash
pi install /path/to/pi-setup
# or
pi install git:github.com/your-user/pi-setup
```

## What's Included

### Extensions

| Extension | Purpose |
|-----------|---------|
| **questionnaire** | Reusable structured question tool |
| **git-guardian** | Commit review gates + destructive command protection |
| **plan-mode** | Read-only investigation + collaborative plan writing |
| **tdd-mode** | Red-green-refactor state machine with refactor gate |

### Skills

| Skill | Trigger |
|-------|---------|
| **conventional-commits** | Writing commit messages |
| **tdd-workflow** | Implementing features with tests |
| **planning** | Designing or architecting before building |
| **code-investigation** | Understanding existing code |
| **git-hygiene** | Commit strategy and history management |

### AGENTS.md

Minimal collaboration style — always in context, under 10 lines.

## Project-Local Overrides

Each project can add its own `.pi/AGENTS.md` or `AGENTS.md` for
project-specific context (test commands, commit scopes, architecture
notes). Pi merges them automatically.
