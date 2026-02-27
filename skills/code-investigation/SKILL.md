---
name: code-investigation
description: >
  How to research and present findings about a codebase. Reading code,
  tracing flows, summarizing architecture. Use when asked to understand,
  explore, or explain existing code.
---

# Code Investigation

## Approach

1. **Map the area** — identify key files, entry points, data flow
2. **Read the code** — understand actual behavior, not just names
3. **Look for context** — tests, config, dependencies, patterns
4. **Summarize with "so what"** — what matters for the task at hand
5. **Pause for feedback** — present findings before proposing changes

## What to Look For

- Entry points and public API surface
- Data flow: where does input come from, where does output go
- Existing tests and what they cover
- Configuration and environment dependencies
- Patterns and conventions the codebase follows
- Error handling approach
- Dependencies and what they provide

## Presenting Findings

- Reference file and line, don't dump raw code
- Explain what matters, not everything you found
- Structure as: what exists → how it works → what's relevant
- Call out surprises, risks, or constraints
- Keep it concise — the user can ask for more detail

## What Not to Do

- Don't dump entire files into the conversation
- Don't describe code mechanically line-by-line
- Don't propose changes before presenting findings
- Don't skip investigation and jump to solutions
