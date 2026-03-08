# History Guardian Extension

Intercepts destructive or history-rewriting git commands and
requires confirmation before execution.

## What It Does

Commands like `git push --force`, `git reset --hard`, and
`git rebase` are caught before execution. You can allow,
steer, or block them. Severity is shown as risky (recoverable
via reflog) or irrecoverable (data loss likely).
