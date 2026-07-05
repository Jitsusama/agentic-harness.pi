# Quest Workflow Rework Review Checklist

Every PR in the quest-workflow rework (PLAN-20260704-Y1KP37) is held
against this checklist. The seven experience principles are
invariants: no change may violate one. The do-not-lose set is
acceptance criteria: no change may drop a row. Both come from
BRIF-20260704-OUD7YZ.

Copy the two lists into the PR description and check them off, or
state plainly why one does not apply.

## The Seven Experience Principles

Each is an invariant the change must satisfy for both readers, the
human at the terminal and the agent reading the skill.

- [ ] **Honest state.** What is stored is true. A field means what
  it says; nothing sorts, resolves or renders against a value the
  store does not hold.
- [ ] **Declared scope.** What a verb acts on is declared, not
  inferred from the shape of an argument or from ambient focus.
- [ ] **Visible drift.** When the store and reality disagree, the
  disagreement is surfaced, not swallowed. A malformed record is
  reported, never dropped to invisible.
- [ ] **Reversible by default.** A mutation can be undone. Every
  field change is journalled, so recovery is a verb, not a manual
  edit.
- [ ] **One truth, two readers.** The skill, the human render and
  the agent result never disagree with the stored state or with
  each other.
- [ ] **Legible to both.** Output a human can read and an agent can
  parse come from one projection, so neither reader gets the poorer
  view.
- [ ] **Additive growth.** New capability is added; a working
  motion is never removed to make room for it.

## The Do-Not-Lose Set

These load-bearing capabilities must still hold after the change.
The executable tripwire is
`tests/extensions/quest-workflow/do-not-lose.test.ts`.

- [ ] One tool with one verb surface.
- [ ] The single hierarchical model, with documents under quests.
- [ ] The four-kind stage machine and the focus loop.
- [ ] The discipline gate's honest-by-destination classification.
- [ ] Atomic, per-quest-locked writes.
- [ ] Structural edits with a dry-run preview and a reversible
  journal.
- [ ] Create-from-URL seeding.
- [ ] The richness of the show projection.
- [ ] The scaffold-versus-adopt tree split.
- [ ] Working-directory auto-load.
- [ ] The human-owned prose body.

## Skill Co-Evolution

The skill is the agent's specification, so a lagging skill is a
defect in the same PR.

- [ ] `quest-convention` and `quest-format` updated for any changed
  behaviour.
- [ ] The extension README updated.
- [ ] `docs/convention-coverage.md` updated: any rework gap this PR
  closes flipped from red to green with the enforcing file named.
