---
name: github-pr-format
description: >
  PR description structure and narrative. The closed
  three-section body (Situation, Resolution, Validation),
  URI indexing, self-review guidance and title conventions.
  Use when writing or editing a pull request description.
  Pairs with github-cli-convention for command syntax and
  markdown-standard for markdown structure. Follow the user's
  writing voice and prose style guides for description text.
---

# Pull Request Writing

A PR description is the narrative the reviewer reads before
they open a single file. Done well it explains the situation
that motivated the change, the resolution the change embodies
and the validation that proves the resolution is correct. Done
poorly it summarises the diff and adds nothing.

This skill governs the shape and prose of a PR description.
Follow `prose-standard` for voice and `markdown-standard` for
markdown structure; see `github-cli-convention` for the command
surface.

## Title

- Describe the value, not the implementation.
- Not conventional commit format; use descriptive titles.

See `github-cli-convention` for title formatting rules
(Title Case, length, formula).

## Issue and Stack Context

Always start the body with a line linking to the issue:

```markdown
Part of #ISSUE_NUMBER
```

Don't repeat the issue reference in the rest of the
description; the link at the top is sufficient.

When a PR is part of a stack (based on another PR or has
PRs based on it), add a note block after the issue line.
Only include the stack note when there is actually a
stack; omit for standalone PRs based on `main` with
no dependents.

```markdown
Part of #ISSUE_NUMBER

> [!NOTE]
> 👈 #BASE_PR · 👇 **#THIS_PR** · 👉 _next not yet created_
```

Omit the 👈 segment if based on `main`. Omit the 👉
segment if nothing depends on this PR yet.

**When creating a PR based on another PR**, update the
parent PR's description to add or update the 👉 segment
pointing to the new child PR. Do this immediately after
creating the child PR.

## Body Structure

A PR description has exactly three sections, in this order. Each
heading is the emoji and the name together, written precisely as
shown. These three are the whole set; there are no optional
sections and no others. A PR describes a change you have made:
the problem it solved, what it did and the proof it works. Future
work is not a PR's job. It belongs in an issue, not a heading
here.

### 🌐 Situation

Where things stood before this PR, and what motivated the change.
The Situation answers "why does this PR exist?". It carries the
context and the motivation together: the scenario that uncovered
the gap, the failure mode the change retires, the risk it
clears, the drift it corrects. This is the section the reader
spends the most time on and the one they remember. It says what
was wrong, not what you did about it.

### 🔧 Resolution

What this PR does about the situation, at the altitude a
reviewer needs to navigate the diff. Name the mechanism, the
shape change to any public surface, the side effects to
anticipate (renames, moves, dependency bumps). This is the map,
not the territory: the reviewer reads the diff after this
section, so do not walk the diff line by line. It says what you
did, not how every line works and not what you left for later.

### 🔬 Validation

The evidence that the resolution is correct. Name the tests
added or updated, the checks that pass, the manual runs
performed, the edges deliberately probed. Output excerpts and
code spans belong here when the change produces operator-visible
output; this is the section where a fenced block or a code span
is at home. A one-line "the suite passes" is weaker than naming
what you added and what it proves. It says how you know it
works, with evidence rather than assertion.

The three answer, in order: what was wrong, what you did, how you
know it works. Anything you want to add that is none of those
three does not belong in the description.

## URI Indexing

Every URI in the description is a markdown reference link, never
a raw inline URL. Inline, write `[descriptive label][1]`; in a
footer block at the end of the body, write `[1]: https://...` on
its own line. GitHub renders the reference as a hyperlink with
the label as the visible text and the footer disappears, so the
source stays readable and the render stays clean. Reuse a number
for a repeated URI; keep the sequence low and ordered. The
reference label is descriptive prose the reader scans, not
"here" or "this link". See `markdown-standard` for the full
reference-link convention.

## Self-Review Comments

After creating the PR, use the `pr_annotate` tool to propose
inline self-review comments that guide reviewers to areas that
matter. Focus on:

- Design decisions worth explaining
- Assumptions that need validation
- Scope boundaries reviewers should weigh in on
- Deviations from the original plan or issue

Do NOT flag style issues, obvious code or things the diff
already makes clear. An empty comments array is fine when
nothing warrants reviewer attention.

### Choosing Line Ranges

The line range is the first thing a reviewer sees; it
frames the comment before they've read a word. A mismatched
range makes the comment confusing, while a well-chosen one
makes it self-evident.

**The range must contain the code the comment is about.**
Read your comment body, identify the specific code it
discusses and select exactly those lines. If the comment
says "this validation assumes X", the range must show the
validation code, not the function signature three lines
above it.

**Scope the range to the relevant construct:**
- A naming concern → the single line with the declaration
- A logic concern → the conditional block or expression
- A design decision → the function or type that embodies it
- A missing edge case → the lines where handling should be

**Don't over-select.** A 20-line range that includes
imports, blank lines and unrelated code dilutes the
signal. If your comment is about a 3-line conditional,
select those 3 lines, not the entire function.

**Don't under-select.** If the comment discusses how two
things interact (e.g., "this parse step feeds into the
validation below"), include both parts so the reviewer
sees the relationship without scrolling.

**Use a single line only when the comment is about one
line**: a variable name, a magic number, a specific
return value. For anything structural, use a range.

### Validating Line Numbers Against the Diff

GitHub's review API only accepts comments on lines that
appear in the diff. If you try to comment on lines outside
a diff hunk, you'll get a 422 rejection. **Always verify
line numbers against the diff before calling
`pr_annotate`.**

Procedure:

1. Fetch the diff patches:
   ```
   gh api repos/OWNER/REPO/pulls/NUMBER/files \
     --jq '.[] | {filename, patch}'
   ```
2. For each comment, find the target file's patch and
   confirm your `startLine`..`line` range falls within
   a `@@` hunk on the RIGHT side (new file lines, the
   `+N,M` in the hunk header).
3. Only then call `pr_annotate` with those line numbers.

If the code you want to comment on isn't in the diff,
the comment doesn't belong on that line. Either find
diff lines that are relevant to the same point, or
make it a PR-level comment instead.

Do NOT guess line numbers from the file contents. Do NOT
retry with adjusted numbers after a 422; get them right
the first time.

## Worked Example

```markdown
Part of #482

### 🌐 Situation

The runner's trace parser buffered partial frame reads and
retried them. When the trace producer died mid-frame and the
stream closed between two reads, the parser kept the partial
frame forever and returned the same retry signal to the caller.
Operators saw their run hang with no diagnostic, and the hang
was reproducible by killing the producer during a fetch.

### 🔧 Resolution

The parser now treats a closed stream as an end signal when the
underlying descriptor reports end-of-file. Partial frames at the
close are discarded with a debug line, and the parser returns a
clean end-of-stream that propagates up to the run loop as a
normal completion.

### 🔬 Validation

Added a parser test covering the partial-frame-at-close case
that reproduced the hang. The existing happy-path and
complete-frame cases still pass. The full suite passes locally.
```

The Situation names the operator scenario and the failure mode.
The Resolution names the mechanism without walking the diff. The
Validation names the test added and what it proves.

## Quality Checks

Before submitting:

- Do the three sections each do their own job, with no overlap?
  (Situation is the problem, Resolution is what you did,
  Validation is the proof.)
- Would a non-technical stakeholder understand the value?
- Would a senior engineer understand the trade-offs?
- Is every claim in Validation backed by real evidence, not
  assumption?

## After Creating

Immediately after `gh pr create`, always run:

```bash
gh pr edit NUMBER --add-assignee @me
```

This is not optional. Every PR must have an assignee.

## CLI Format

See `github-cli-convention` for command syntax: heredoc
patterns, `--body-file -` and metadata in separate commands.

## What Not to Do

- Don't add sections beyond the three. The set is closed:
  🌐 Situation, 🔧 Resolution, 🔬 Validation. No Follow-ups, no
  Notes, no References heading, no Testing or Description
  section. Future work goes in an issue; links go in the URI
  footer.
- Don't change the heading shape. The headings are `### 🌐
  Situation`, `### 🔧 Resolution`, `### 🔬 Validation`, exactly:
  the emoji, the name, at the `###` level. Not `##`, not a bare
  name, not a different emoji.
- Don't hard-wrap body paragraphs; GitHub reflows them, and hard
  breaks make the text choppy. Write each paragraph as a single
  continuous line.
- Don't list what changed; that's visible in the diff.
- Don't walk the diff in the Resolution; give the map, not the
  territory.
- Don't leave Validation as a bare "tests pass"; name what you
  added and what it proves.
- Don't inline a raw URL; every link is a reference into the URI
  footer.
