# Git CLI Interceptor

Enforces the `commit-format` skill's "one concern per bash
call" rule. Blocks compound commands that would bypass
guardians, telling the caller to retry with one command per
bash call.

Each block states the corrective action itself. They used to
end by naming a skill to read, which only helps while that
skill is loaded; one of them named `git-cli-convention`,
whose worked example the amend check blocked.

## What It Catches

- `git commit --amend`: amends rewrite history and are
  almost never the right choice. Make a new commit instead.
- `git commit` with an unquoted heredoc delimiter
  (`<<EOF` instead of `<<'EOF'`), which allows shell
  variable expansion to corrupt the commit message.
- Multiple guardable commands chained together (e.g.,
  `git commit && gh pr create`)
- Git state changes mixed with guardable commands (e.g.,
  `git push && gh pr create`, `git checkout && git commit`)

## What It Allows

- `git add && git commit` (staging prefix is explicitly
  allowed)
- `cd /path && git commit` (directory prefix is safe)
- Single guardable commands with or without a prefix
