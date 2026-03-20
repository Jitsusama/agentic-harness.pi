# Attribution Extension

Injects AI co-authorship attribution into commits, PRs, and
issues created through Pi. Makes AI involvement transparent
and helps analytics tooling detect AI-assisted work.

## What It Does

Intercepts bash commands before they execute and appends
attribution metadata:

**Commits** get a git trailer:

```
Co-Authored-By: AI (Claude Sonnet 4 via Pi) <noreply@pi.dev>
```

**PRs and issues** get a markdown footer:

```
---
Co-Authored-By AI (Claude Sonnet 4) via [Pi](https://github.com/badlogic/pi-mono)
```

The model name is pulled from the active model at command time,
so each commit reflects the model that was actually used.

## Load Order

The extension loads before guardians alphabetically
(`attribution` < `commit-guardian`), so the user sees the
injected attribution text during the guardian's review panel.

## Disabling

Pass `--no-attribution` when starting Pi:

```sh
pi --no-attribution
```

## Idempotency

If the message or body already contains `Co-Authored-By` with
`AI` (case-insensitive), the extension skips injection. This
prevents duplicate attribution on amended commits or edited PRs.

