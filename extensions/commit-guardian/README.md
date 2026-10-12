# Commit Guardian Extension

Intercepts `git commit` commands and shows the commit message
with its validation marks (subject length, body wrap,
conventional format).

## What It Does

The `commit` guard reports by default: the commit runs, and the
message and its marks appear in the transcript. Switched to
block (`/guards commit block`), every commit opens a gate where
you can approve, edit, steer or reject it.

Before that, two redirects can refuse the commit, each in block
mode by default:

- `commit-verification` refuses while the verification workflow
  reports the code is failing, so a red build does not get
  committed by reflex. When that report is wrong or stale,
  `/guards commit-verification report` lets commits through and
  records what it would have said.
- `prose` refuses a message that breaks the prose standard.

See [guard-policy-workflow](../guard-policy-workflow/README.md)
for modes and how to set them.
