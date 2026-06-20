# Attribution Extension

Injects AI co-authorship attribution into commits, PRs and
issues created through Pi. This makes AI involvement
transparent and helps analytics tooling detect AI-assisted
work.

## What It Does

It attributes the work two ways, by surface.

**Commits** get a git trailer:

```
Co-Authored-By: AI (Claude Sonnet 4 via Pi) <noreply@pi.dev>
```

Commits are attributed by a `prepare-commit-msg` hook, not by
rewriting the command. The hook appends the trailer to the
message file for every commit pi drives, the typed commit and
the cherry-pick, revert, rebase, merge and editor paths a
command rewrite could never see, and it never reshapes the
command. The extension installs the hook in each repo the
session touches and exports `PI_CO_AUTHOR` so child git
processes carry the current model. It leaves a repo with a
custom `core.hooksPath` (husky and the like) alone, and chains
any existing hook rather than shadowing it.

**PRs and issues** get a markdown footer:

```
---
Co-Authored-By AI (Claude Sonnet 4) via [Pi](https://github.com/badlogic/pi-mono)
```

The model name is pulled from the active model at command
time, so each commit reflects the model that was actually
used.

PRs and issues are attributed by splicing the footer into the
body in place, so the leading `cd`, environment assignments
like `GH_HOST` and every other flag survive untouched. A
`gh pr` or `gh issue` create or edit in a shape outside the
supported grammar (wrapped in command substitution, a subshell
or a pipe), or with an unquoted inline body the footer cannot
splice into safely, is blocked with a reason that asks for a
simpler form, rather than allowed to run un-attributed.

## Load Order

The extension loads before guardians alphabetically
(`attribution` < `commit-guardian`), so you'll see a spliced
gh body footer during the guardian's review panel. A commit
trailer is added by the hook at commit time, so it lands in
the commit rather than the review panel.

## Always On

Attribution is unconditional: there is no opt-out flag. A
guardable command carries attribution or it does not run.

## Idempotency

If the message or body already contains `Co-Authored-By` with
`AI` (case-insensitive), the extension skips injection. This
prevents duplicate attribution on amended commits or edited
PRs.
