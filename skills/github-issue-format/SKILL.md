---
name: github-issue-format
description: >
  Issue body structure and narrative. Problem statements,
  acceptance criteria and body organization. Use when writing
  or editing a GitHub issue. Pairs with github-cli-convention
  for command syntax. Follow the user's writing voice and
  prose style guides for issue text.
---

# Issue Writing

An issue is a contract between the person requesting work and
the person doing it. It needs to be clear enough that someone
unfamiliar with the context can understand what needs to
happen, why it matters and how to know when it's done.

## Title

- Describe the outcome, not the task.

See `github-cli-convention` for title formatting rules
(Title Case, length, formula).

## After Creating

Immediately after `gh issue create`, always run:

```bash
gh issue edit NUMBER --add-assignee @me
```

This is not optional. Every issue must have an assignee.

## CLI Format

See `github-cli-convention` for command syntax: heredoc
patterns, `--body-file -` and metadata in separate commands.

## What Not to Do

- Don't hard-wrap body paragraphs; GitHub reflows them,
  and hard breaks make the text choppy. Write each
  paragraph as a single continuous line.
- Don't write implementation plans; that belongs in PRs.
- Don't use vague acceptance criteria like "works correctly."
- Don't skip the problem statement and jump to the solution.
- Don't combine unrelated work in a single issue.
- Don't leave the acceptance criteria empty.
