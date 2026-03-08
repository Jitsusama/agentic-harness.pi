# Git Guardian Extension

Safety net for git operations. Intercepts commits and destructive
commands before they execute.

## What It Does

**Commit review** — Every `git commit` is intercepted. You see the
message with validation indicators (subject length, body wrap,
conventional format) and can approve, edit, steer, or reject.

**Destructive command protection** — Commands like `git push --force`,
`git reset --hard`, and `git rebase` are caught before execution.
You can allow, steer, or block them.
