---
name: conventional-comments
description: >
  Conventional Comments format for review feedback. Labels,
  decorations and tone guidance. Use when writing review
  comments, giving code feedback or formatting review
  observations.
---

# Conventional Comments

## Format

```
<label> [decorations]: <subject>

[discussion]
```

Every review comment follows this structure. The label
classifies the intent, decorations indicate severity, the
subject is a one-line summary and the discussion explains
reasoning.

## Labels

| Label | Purpose | Blocking? |
|-------|---------|-----------|
| `praise` | Something positive | Never |
| `nitpick` | Trivial preference | Never |
| `suggestion` | Proposed improvement | Sometimes |
| `issue` | Specific problem | Often |
| `question` | Potential concern | Sometimes |
| `thought` | Idea from reviewing | Never |
| `todo` | Small necessary change | Usually |
| `note` | Informational highlight | Never |
| `chore` | Process requirement | Sometimes |

### Label Selection

- Use `praise` at least once per review; acknowledge
  things done well.
- Pair `issue` with `suggestion` when possible; don't
  just point out problems, offer alternatives.
- Use `question` when genuinely unsure, not as passive
  aggression.
- Use `nitpick` for pure preference; be honest about it.
- Use `thought` for ideas that don't need action.

## Decorations

Add parenthetical decorations after the label:

- `(blocking)`: must be resolved before merge.
- `(non-blocking)`: won't prevent merge.
- `(if-minor)`: resolve only if the fix is trivial.

Examples:
```
suggestion (non-blocking): Consider extracting validation...
issue (blocking): Missing null check causes crash...
nitpick (non-blocking): Prefer const over let here...
```

## Tone

### Canadian-Polite and Instructional

The tone should be warm, instructional and teaching-oriented.
Not just "what's wrong" but "what I think and why." Explain
reasoning, suggest alternatives, teach.

### Good Examples

```
suggestion (non-blocking): Consider using the existing
`validateInput()` helper here.

I noticed that `src/utils/validation.ts:23` already has a
validation function that handles this exact case. Using it
would keep the validation logic in one place and make it
easier to update if the rules change. The pattern used in
`src/api/users.ts:45` shows how other endpoints integrate
with it.
```

```
question (non-blocking): What happens if `prefs` is null
here?

I see the function accepts `prefs` without a null check,
but looking at the callers in `src/routes/settings.ts:30`,
it seems possible for the request body to be empty. The
existing pattern in `src/api/users.ts:12` guards against
this with an early return; it might be worth considering the
same approach here.
```

```
praise: Clean separation of concerns here.

The way validation, transformation and persistence are
handled in separate steps makes this very easy to follow
and test independently. Nice work.
```

### Bad Examples

```
issue: Use validateInput() instead.
```
→ Terse and demanding. No explanation of why.

```
question: Did you not see the existing validation helper?
```
→ Passive-aggressive. Implies negligence.

```
suggestion: This is wrong, fix it.
```
→ Not a suggestion, and not helpful.

## Evidence-Based Comments

Cite concrete evidence in your comments:

- Reference specific files and line numbers.
- Show search results (`rg` output) for patterns.
- Link to existing implementations as examples.
- Quote relevant documentation or conventions.

## Formatting in `add-comment`

When calling `pr_review` with `add-comment`, map the
conventional comment format to the structured fields:

- `label`: the conventional comment label.
- `decorations`: array of decorations, e.g. `["non-blocking"]`.
- `subject`: the subject line after the colon.
- `discussion`: the body paragraphs explaining reasoning.

The extension formats these into the conventional comment
syntax when posting to GitHub.

## What Not to Do

- Don't use labels as weapons ("issue: you did this wrong").
- Don't mark everything as blocking.
- Don't skip the discussion; the reasoning matters most.
- Don't forget praise; reviews are for encouragement too.
- Don't be vague in discussions ("this seems off").
- Don't use `question` to make demands.
