# GitHub CLI Interceptor

Enforces the `github-cli-convention` skill's formatting
rules. Blocks gh pr/issue commands that use the wrong body
format or pack metadata into create commands, directing the
LLM to read the convention skill and retry.

## What It Catches

- `gh pr/issue create/edit` with `--body` instead of
  `--body-file -` with heredoc
- `gh pr/issue create/edit` with `--body-file <path>`
  pointing at a file instead of stdin (`-`)
- `gh pr/issue create/edit` with `--body-file -` but no
  heredoc to feed it (would hang waiting for stdin)
- `gh pr/issue create/edit` with an unquoted heredoc
  delimiter (`<<EOF` instead of `<<'EOF'`), which allows
  shell variable expansion to corrupt the body
- `gh pr/issue create` with metadata flags (`--label`,
  `--assignee`, `--reviewer`, `--milestone`, `--project`)
  that should be in separate edit commands

## What It Allows

- `gh pr/issue create/edit` with `--body-file -` and a
  quoted heredoc (`<<'EOF'`)
- `gh pr/issue edit` with metadata flags (editing after
  creation is the intended pattern)
- `gh pr/issue create` with structural flags (`--base`,
  `--head`, `--draft`, `--repo`)
