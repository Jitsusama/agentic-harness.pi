---
name: code-investigation-guide
description: >
  How to research and present findings about a codebase.
  Reading code, tracing flows, summarizing architecture.
  Use when understanding, exploring or explaining existing
  code before proposing changes.
---

# Code Investigation

## Approach

1. **Map the area**: identify key files, entry points, data flow.
2. **Read the code**: understand actual behaviour, not just names.
3. **Look for context**: tests, config, dependencies, patterns.
4. **Summarize with "so what"**: what matters for the task at hand.
5. **Pause for feedback**: present findings before proposing changes.

## What to Look For

- Entry points and public API surface
- Data flow: where does input come from, where does output go
- Existing tests and what they cover
- Configuration and environment dependencies
- Patterns and conventions the codebase follows
- Error handling approach
- Dependencies and what they provide

## Presenting Findings

- Reference file and line; don't dump raw code.
- Explain what matters, not everything you found.
- Structure as: what exists → how it works → what's relevant.
- Call out surprises, risks or constraints.
- Keep it concise; the user can ask for more detail.

## Command Output Fidelity

RTK may compress output from bash commands. Pi's native
`grep`, `find` and `ls` tools bypass RTK entirely (they
aren't bash), so prefer those for searching and listing.

For piped commands (`git log | head -20`), RTK rewrites
the left side but passes the right side through unchanged.
The pipe target receives RTK-compressed input.

When running git commands through bash during investigation,
be aware that RTK caps `git log` at 10 entries, injects
`--no-merges` silently and truncates lines. If you need
full commit history or complete messages, prefix the
command with `NORTK=1` to bypass compression:

```bash
NORTK=1 git log --oneline -20
```

The `NORTK=1` prefix is stripped before execution; bash
never sees it as an environment variable. It works on any
bash command, not just git.

## What Not to Do

- Don't dump entire files into the conversation.
- Don't describe code mechanically line-by-line.
- Don't propose changes before presenting findings.
- Don't skip investigation and jump to solutions.
