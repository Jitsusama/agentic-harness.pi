# History Guardian Extension

Intercepts git commands that rewrite history or discard work,
as two guards, one per severity. Each segment of a chained
command is judged on its own, and text inside quotes (a commit
message, say) is never mistaken for a command.

## What It Does

- `history` covers what the reflog can undo: `git rebase`,
  `git stash drop` and `git push --force-with-lease`. It
  reports by default, so the command runs and a note appears
  in the transcript. In block mode it asks first.
- `history-destructive` covers what cannot be undone:
  `git reset --hard`, `git clean -f`, a bare `git push --force`,
  `git branch -D` and `git checkout -- .`. It blocks by
  default, and it never asks: it refuses with the safe form of
  the command, so the agent can retry that instead. A bare
  `--force` push is the exception: it is rewritten to
  `--force-with-lease` and run, with a note saying so.

When the user wants an irrecoverable command run as written,
they can run it themselves, or let it through with
`/guards history-destructive report`. See
[guard-policy-workflow](../guard-policy-workflow/README.md).
