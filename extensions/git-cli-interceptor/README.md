# Git CLI Interceptor

Enforces the `git-cli-convention` skill's "one concern per
bash call" rule. Blocks compound commands that would bypass
guardians, directing the LLM to read the convention skill
and retry with separate bash calls.

## What It Catches

- `git commit --amend` — amends rewrite history and are
  almost never the right choice. Make a new commit instead.
- Multiple guardable commands chained together (e.g.,
  `git commit && gh pr create`)
- Git state changes mixed with guardable commands (e.g.,
  `git push && gh pr create`, `git checkout && git commit`)

## What It Allows

- `git add && git commit` (staging prefix is explicitly
  allowed)
- `cd /path && git commit` (directory prefix is safe)
- Single guardable commands with or without a prefix
