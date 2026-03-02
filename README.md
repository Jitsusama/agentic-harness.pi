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

| Extension | Purpose | Always on? |
|-----------|---------|------------|
| **git-guardian** | Commit review + destructive command protection | Yes |
| **ask** | Reusable structured question tool | Yes (available to agent) |
| **plan-mode** | Read-only investigation + plan writing | Toggle: `/plan` or `Ctrl+Alt+P` |
| **tdd-mode** | Red-green-refactor state machine | Toggle: `/tdd` or `Ctrl+Alt+T` |

### Skills

| Skill | Loads when... |
|-------|---------------|
| **conventional-commits** | Writing commit messages, discussing conventions |
| **tdd-workflow** | Implementing features with tests |
| **planning** | Designing or architecting before building |
| **code-investigation** | Understanding existing code |
| **git-hygiene** | Discussing commit strategy or history |
| **branch-management** | Creating branches, switching, moving commits |
| **pr-writing** | Creating pull requests, writing PR descriptions |
| **rebase-resolution** | Rebasing, resolving merge conflicts |
| **github-sub-issues** | Managing sub-issues (query, reorder, create) |
| **github-projects** | Managing GitHub Projects v2 items |

### AGENTS.md

Minimal collaboration style — always in context, under 10 lines.
Covers: explain findings, pause before big changes, research first,
review all commits, ask when ambiguous.

## Usage

### Planning a Feature

Say "let's plan this out" — the agent loads the planning skill and
investigates before proposing. Use `/plan` if you want read-only
enforcement (no code modifications until you transition out).

Plans are written to `.pi/plans/` by default. Override with
`/plan-dir <path>` or in `.pi/settings.json`:

```json
{ "planDir": "docs/architecture/plans" }
```

After the plan is written, you're offered: TDD, free-form, or
stay in planning.

### TDD Implementation

Say "let's TDD this" or use `/tdd` for phase enforcement.
With a plan file: `/tdd .pi/plans/2026-02-27-my-plan.md`.

The state machine tracks red → green → refactor phases. During
red phase, writes to implementation files require confirmation
(test files are unrestricted). After each green, a refactor gate
pauses for your input. After refactor, a commit is proposed
(reviewed by git-guardian).

### GitHub Issue & Project Management

Use the github-sub-issues and github-projects skills when working
with parent/child issue relationships or GitHub Projects v2 boards.
Both include helper scripts in their `scripts/` directories.

### Committing

The agent uses heredoc format for commits (taught by the
conventional-commits skill). Git-guardian intercepts every commit
for review with validation indicators (subject length, body wrap,
conventional format). Approve, steer (give feedback), edit, or
reject.

Destructive git commands (reset --hard, push --force, etc.) get
a similar gate: allow, steer, or block.

### Research

Just ask — "help me understand how X works." The code-investigation
skill guides the agent to investigate thoroughly and present
focused summaries.

## Composability

Every piece works alone. Skills guide behavior without extensions.
Extensions add enforcement. The matrix:

- **Skills only** — agent follows guidance voluntarily
- **Git-guardian only** — commit review works without any skills
- **Plan-mode only** — read-only enforcement without TDD
- **TDD-mode only** — phase enforcement without planning
- **All together** — plan → TDD → commit flows seamlessly

## Project-Local Overrides

Each project can customize via `.pi/`:

```markdown
<!-- AGENTS.md or .pi/AGENTS.md -->
Test command: `cargo test`
Commit scopes for this project: api, cli, core, db
```

```json
// .pi/settings.json
{ "planDir": "docs/plans" }
```

## Commands

| Command | Description |
|---------|-------------|
| `/plan` | Toggle plan mode (read-only investigation) |
| `/plan-dir [path]` | Show or set plan directory |
| `/tdd [plan-file]` | Toggle TDD mode |

## Keyboard Shortcuts

| Shortcut | Description |
|----------|-------------|
| `Ctrl+Alt+P` | Toggle plan mode |
| `Ctrl+Alt+T` | Toggle TDD mode |
