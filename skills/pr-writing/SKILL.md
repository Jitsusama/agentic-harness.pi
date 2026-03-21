---
name: pr-writing
description: >
  Pull request structure, narrative and review guidance. Use
  when writing PR descriptions or discussing what makes a good
  PR. Covers body structure, story types and self-review.
---

# Pull Request Writing

A PR has three layers: the code changes (reviewers can see
these), the technical decisions (you must explain these) and
the business impact (you must connect to this). Your job is to
build bridges from the inner layer to the outer one.

## Title

- Describe the value, not the implementation.
- Not conventional commit format; use descriptive titles.

See `gh-cli-conventions` for title formatting rules
(Title Case, length, formula).

## Issue and Stack Context

Always start the body with a line linking to the issue:

```markdown
Part of #ISSUE_NUMBER
```

Do not repeat the issue reference in the rest of the
description; the link at the top is sufficient.

When a PR is part of a stack (based on another PR or has
PRs based on it), add a note block after the issue line.
Only include the stack note when there is actually a
stack; omit for standalone PRs based on `main` with
no dependents.

```markdown
Part of #ISSUE_NUMBER

> [!NOTE]
> 👈 #BASE_PR · 👇 **#THIS_PR** · 👉 _next not yet created_
```

Omit the 👈 segment if based on `main`. Omit the 👉
segment if nothing depends on this PR yet.

**When creating a PR based on another PR**, update the
parent PR's description to add or update the 👉 segment
pointing to the new child PR. Do this immediately after
creating the child PR.

## Body Structure

### 🔍 What We're Doing

One paragraph connecting the change to the problem it solves.
Link to issues or references.

### 💡 Why This Matters

The "so what": why should anyone care? State the impact:
"Without this, [specific bad thing] happens, causing
[measurable consequence]."

### 🔧 How It Works

Key decisions and trade-offs only, not implementation
details visible in the diff. "Chose A over B because C
matters more than D for this use case."

## Story Types

Recognize what kind of story the changes tell:

- **Performance**: lead with the metrics that were bad.
- **Reliability**: lead with the failure scenarios.
- **Security**: lead with the risk or compliance need.
- **Feature**: lead with the user problem being solved.

## Self-Review Comments

After creating the PR, use the `pr_annotate` tool to propose
inline self-review comments that guide reviewers to areas that
matter. Focus on:

- Design decisions worth explaining
- Assumptions that need validation
- Scope boundaries reviewers should weigh in on
- Deviations from the original plan or issue

Do NOT flag style issues, obvious code or things the diff
already makes clear. An empty comments array is fine when
nothing warrants reviewer attention.

### Choosing Line Ranges

The line range is the first thing a reviewer sees; it
frames the comment before they read a word. A mismatched
range makes the comment confusing; a well-chosen range
makes the comment self-evident.

**The range must contain the code the comment is about.**
Read your comment body, identify the specific code it
discusses and select exactly those lines. If the comment
says "this validation assumes X", the range must show the
validation code, not the function signature three lines
above it.

**Scope the range to the relevant construct:**
- A naming concern → the single line with the declaration
- A logic concern → the conditional block or expression
- A design decision → the function or type that embodies it
- A missing edge case → the lines where handling should be

**Don't over-select.** A 20-line range that includes
imports, blank lines and unrelated code dilutes the
signal. If your comment is about a 3-line conditional,
select those 3 lines, not the entire function.

**Don't under-select.** If the comment discusses how two
things interact (e.g., "this parse step feeds into the
validation below"), include both parts so the reviewer
sees the relationship without scrolling.

**Use a single line only when the comment is about one
line**: a variable name, a magic number, a specific
return value. For anything structural, use a range.

### Validating Line Numbers Against the Diff

GitHub's review API only accepts comments on lines that
appear in the diff. Comments on lines outside diff hunks
are rejected with a 422. **Always verify line numbers
against the diff before calling `pr_annotate`.**

Procedure:

1. Fetch the diff patches:
   ```
   gh api repos/OWNER/REPO/pulls/NUMBER/files \
     --jq '.[] | {filename, patch}'
   ```
2. For each comment, find the target file's patch and
   confirm your `startLine`..`line` range falls within
   a `@@` hunk on the RIGHT side (new file lines, the
   `+N,M` in the hunk header).
3. Only then call `pr_annotate` with those line numbers.

If the code you want to comment on isn't in the diff,
the comment doesn't belong on that line. Either find
diff lines that are relevant to the same point, or
make it a PR-level comment instead.

Do NOT guess line numbers from the file contents. Do NOT
retry with adjusted numbers after a 422; get them right
the first time.

## The Three Questions

Every PR must answer:

1. What problem does this solve?
2. Why this approach over alternatives?
3. What could go wrong?

## Quality Checks

Before submitting:

- Would a non-technical stakeholder understand the value?
- Would a new team member know what to review carefully?
- Would a senior engineer understand the trade-offs?
- Is every claim backed by real data, not assumptions?

## After Creating

Immediately after `gh pr create`, always run:

```bash
gh pr edit NUMBER --add-assignee @me
```

This is not optional. Every PR must have an assignee.

## CLI Format

See `gh-cli-conventions` for command syntax: heredoc
patterns, `--body-file -` and metadata in separate commands.

## What Not to Do

- Don't hard-wrap body paragraphs; GitHub reflows them,
  and hard breaks make the text choppy. Write each
  paragraph as a single continuous line.
- Don't list what changed; that's visible in the diff.
- Don't use generic phrases like "improves performance."
- Don't skip the "why" and jump to the "what."
- Don't leave the review focus empty or vague.
