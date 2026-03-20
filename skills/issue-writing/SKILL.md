---
name: issue-writing
description: >
  GitHub issue structure and narrative. Use when writing issue
  descriptions or discussing what makes a good issue. Covers
  problem statements, acceptance criteria, and body structure.
---

# Issue Writing

An issue is a contract between the person requesting work and
the person doing it. It must be clear enough that someone
unfamiliar with the context can understand what needs to happen,
why it matters, and how to know when it's done.

## Title

- Describe the outcome, not the task

See `gh-cli-conventions` for title formatting rules
(Title Case, length, formula).

## After Creating

Immediately after `gh issue create`, always run:

```bash
gh issue edit NUMBER --add-assignee @me
```

This is not optional. Every issue must have an assignee.

## CLI Format

See `gh-cli-conventions` for command syntax — heredoc
patterns, `--body-file -`, and metadata in separate commands.

## What Not to Do

- Don't hard-wrap body paragraphs — GitHub reflows them,
  and hard breaks make the text choppy. Write each
  paragraph as a single continuous line.
- Don't write implementation plans — that belongs in PRs
- Don't use vague acceptance criteria like "works correctly"
- Don't skip the problem statement and jump to the solution
- Don't combine unrelated work in a single issue
- Don't leave the acceptance criteria empty
