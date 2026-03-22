---
name: taxonomy-guide
description: >
  Naming taxonomy for skills and extensions in this package.
  Domains, type suffixes, location rules and the decision
  framework for when to create a new skill, extension or
  add to AGENTS.md. Use when creating, renaming or
  reorganizing skills and extensions.
---

# Taxonomy

This skill defines how skills and extensions are named,
categorized and organized in this package. Follow it when
creating new ones, renaming existing ones or deciding where
a piece of guidance belongs.

## Skill Naming

Every skill name follows the pattern
`{domain}-{concern}-{suffix}`, where the domain groups
related skills together alphabetically, the concern
describes the specific topic, and the suffix tells you what
kind of skill it is. Some skills have a single-word concern
that makes the domain and concern indistinguishable (e.g.,
`planning-guide`); that's fine when the domain *is* the
concern.

### Domains

Domains are the subject matter. They should all be at the
same level of abstraction: nouns that describe what the skill
is about, not verbs or activities.

- **code**: source code (style, investigation, review, TDD)
- **git**: version control (branches, rebases, CLI, commits)
- **github**: the GitHub platform (PRs, issues, projects,
  sub-issues, CLI)
- **google**: Google Workspace services
- **planning**: investigation and plan creation (broader than
  code; covers mastery cycles, documentation, weekly planning)
- **prose**: written voice and style that transcends any
  single artifact type
- **(no prefix)**: technology-neutral artifact formats that
  apply regardless of platform (conventional commits,
  conventional comments)

When a skill is about a format standard that isn't tied to a
specific platform, it gets no domain prefix. The absence of a
prefix signals technology neutrality. Platform-specific
formats get their platform domain prefix (`github-pr-format`,
`github-issue-format`).

### Type Suffixes

Four suffixes describe what a skill *is*. Every skill gets
exactly one.

- **-guide**: teaches how to do something. Step-by-step
  instructions, principles, decision criteria. Paired with
  workflow extensions when the guidance drives an interactive
  process.
- **-convention**: operational rules for using a tool. How
  to format commands, when to commit, branch naming rules.
- **-format**: structural template for an artifact. What a
  commit message, PR body, issue body or review comment
  should look like.
- **-standard**: opinionated quality and style preferences.
  What good code looks like, how prose should sound, what to
  look for in reviews.

When deciding which suffix to use, ask: does this skill tell
you *how to do* something (guide), *how to use* a tool
(convention), *how to structure* an artifact (format), or
*what quality looks like* (standard)?

## Extension Naming

Every extension name follows the pattern
`{name}-{contract}`, where the name describes what the
extension does and the contract suffix identifies its
behavioural contract.

### Contract Suffixes

- **-guardian**: intercepts shell commands and presents a
  human review gate. Implements the `CommandGuardian<T>`
  interface with detect, parse and review steps. The user
  sees the command and can approve, reject or modify it.
- **-interceptor**: intercepts shell commands and modifies
  them silently. Same interception mechanism as guardians
  but without the review gate. The modification happens
  automatically.
- **-workflow**: orchestrates a multi-step or session-wide
  process with state and stages. This covers both
  persistent session modes (planning, TDD) and task-scoped
  orchestration (PR review, PR reply, structured questions).
  The defining characteristic is state and transitions.
- **-integration**: bridges to an external service. Registers
  tools that connect to APIs, browsers or other systems
  outside of pi.
- **-widget**: adds UI elements to the interface. Visual
  components like content viewers, status indicators and
  panel controls.

Every extension must have exactly one suffix. If an extension
seems to fit multiple categories, the *primary* behavioural
contract wins. A widget that also intercepts keyboard input
is still a widget if its primary purpose is visual.

## Skill Locations

- **`./skills/`**: package-bound skills shipped to anyone who
  installs this package. These teach general methodology,
  conventions, formats and standards that apply across
  projects.
- **`.pi/skills/`**: project-local skills that only matter
  when developing *this* package. Extension development
  guidance, keybinding conventions and this taxonomy itself
  live here.

The test: would someone installing this package as a consumer
benefit from this skill? If yes, it goes in `./skills/`. If
it's about building or maintaining the package itself, it
goes in `.pi/skills/`.

## When to Create What

### New Skill vs AGENTS.md

AGENTS.md describes the project's structure, conventions and
design principles. It's always loaded and always in context.
Skills are loaded on demand when a task matches their
description.

Put it in AGENTS.md when:
- It's a project-specific rule that always applies (file
  naming conventions, linting requirements, import rules).
- It's structural context the agent needs regardless of the
  task (directory layout, extension categories, library
  organization).

Create a skill when:
- It's guidance for a specific type of task that doesn't
  apply to every interaction (how to write a PR, how to
  investigate code, how to do TDD).
- It's reusable across projects (code style preferences,
  prose voice, git conventions).
- Loading it unconditionally would waste context on tasks
  that don't need it.

### New Skill vs New Extension

Skills teach methodology. Extensions enforce it. Some are
paired: the planning guide teaches the process; the planning
workflow extension enforces constraints and manages state.

Create a skill when:
- The guidance is about *how to think* about a task, not
  *what to enforce* at runtime.
- There's no state to manage, no commands to intercept, no
  UI to render.

Create an extension when:
- There's runtime behaviour: intercepting commands, managing
  state, registering tools, rendering UI.
- The behaviour needs to be enforced automatically, not just
  documented.

When both are needed, the skill and extension get
complementary names: the skill suffix describes the
guidance type (`-guide`, `-format`, `-standard`), and the
extension suffix describes the behavioural contract
(`-workflow`, `-guardian`, `-widget`).

### Package-Bound vs Project-Local

If the skill is about this package's internals (how to write
extensions, keybinding conventions, taxonomy rules), it goes
in `.pi/skills/`. If it's about a general practice that any
consumer of this package would benefit from, it goes in
`./skills/`.
