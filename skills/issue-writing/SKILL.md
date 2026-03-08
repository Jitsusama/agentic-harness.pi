---
name: issue-writing
description: >
  GitHub issue structure, narrative, and CLI format. Use when
  creating issues, editing issue descriptions, or discussing
  what makes a good issue.
---

# Issue Writing

An issue is a contract between the person requesting work and
the person doing it. It must be clear enough that someone
unfamiliar with the context can understand what needs to happen,
why it matters, and how to know when it's done.

## Title

- Use Title Case — not lowercase or sentence case
- Describe the outcome, not the task
- 50–72 characters
- Formula: `[Action] [What] [For What Purpose]`

Good: "Add Rate Limiting to Prevent API Abuse"
Bad: "rate limiting work"

## Labels, Assignees, and Projects

After creating or editing the issue, assign metadata in
separate commands:

```bash
gh issue edit NUMBER --add-label "label1" --add-label "label2"
gh issue edit NUMBER --add-assignee @me
```

Do not pack metadata flags into the create command — keep
the create command focused on title and body.

## Creating Issues via CLI

Use `--body-file -` with a stdin heredoc to pass the body:

```bash
gh issue create \
  --title "Add Rate Limiting to Prevent API Abuse" \
  --body-file - <<'ISSUE_BODY'
Body content here — em dashes, backticks, and special
characters all work reliably without escaping.
ISSUE_BODY
```

The single-quoted `'ISSUE_BODY'` delimiter prevents variable
expansion — em dashes, backticks, dollar signs, and special
characters all work reliably without escaping.

## Editing Issues via CLI

Use the same heredoc pattern for edits:

```bash
gh issue edit NUMBER \
  --body-file - <<'ISSUE_BODY'
Updated body content here.
ISSUE_BODY
```

To update only the title:

```bash
gh issue edit NUMBER --title "New Title Here"
```

## What Not to Do

- Don't write implementation plans — that belongs in PRs
- Don't use vague acceptance criteria like "works correctly"
- Don't skip the problem statement and jump to the solution
- Don't combine unrelated work in a single issue
- Don't leave the acceptance criteria empty
