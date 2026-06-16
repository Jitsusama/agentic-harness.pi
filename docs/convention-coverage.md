# Convention Coverage Matrix

A rule-to-gate audit of every skill in this package. For each
mechanically-checkable rule a skill states, this document records
which gate enforces it, which silent translation handles it, or
why it is deliberately not gated.

The matrix exists because the root cause of every gap the
adversarial review found was the same: rules sat in skills with no
systematic check that something in the code enforced them. The
title gate is the most recent example. With this document in
place, the next time a skill adds a rule or a gate is built, the
contributor updates the matrix and the gap stays visible instead
of slipping into the wild for someone to spot in a bad artifact.

## How to Use This Document

- **Adding a rule to a skill?** Add a row to the matrix at the
  same time. Mark it 🟢 if a gate already covers it, 🔴 if it is
  a new gap, or 🚫 with a rationale if it is deliberately not
  gated.
- **Adding a gate?** Flip the row it satisfies from 🔴 to 🟢 and
  point at the file that runs it.
- **Removing a rule?** Remove the row, or move it to a Removed
  section if the rationale is worth remembering.

## Legend

| Symbol | Meaning |
| --- | --- |
| 🟢 | **Enforced.** A gate detects the violation and blocks the first offence with a skill-grounded message. |
| 🔇 | **Silent translation.** A render-identical conversion happens at write time with no gate or block. Reserved for cases with exactly one correct output and zero judgment. |
| 📋 | **Advisory only.** Validated and surfaced in the human review panel as an indicator, but never blocked. |
| 🚫 | **Deliberately not gated.** Mechanically detectable but excluded on purpose, with the rationale recorded. |
| ⚪ | **Skill-only.** Judgment-based rule, not mechanically detectable. Lives in the skill and the resident reminder. |
| 🔴 | **Gap.** Gateable rule with no gate. Action item. |

## Open Gaps

None open. The glyph-bullet gap recorded here previously is now
🟢 enforced: `lib/slack/detect.ts` flags a run of two or more
lines led by a `•`, `‣`, `◦`, `▪` or `·` glyph and blocks with
a message pointing the author at the markdown markers, using the
same conservative run-of-two threshold as the existing
malformed-bullet scan so a lone arithmetic `3 · 4` line never
trips it.

The PR and issue title length entry that previously
lived here is now 🟢 enforced on the upper bound and ⚪ skill-only
on the lower bound, the same precision-over-recall split the
spelling allowlist and Title Case exclusion already use. The
rationale lives in the cli convention skill itself: past 72
characters the title truncates in GitHub views and reads badly in
logs, so the gate blocks it; below 50 a short descriptive title
("Add Dark Mode Toggle" is 20 characters and clear) is fine, so
the lower bound stays a nudge.

The commit-format trio (subject length, body wrap,
conventional-commit subject) is 📋 advisory in the human review
panel, not 🔴. That posture is deliberate: hard-blocking on a
51-character subject would frustrate more than it helps, the
panel already surfaces `✓ conventional` or `⚠ not conventional`
as an indicator, and a PR rolling up a non-conventional commit is
separately covered by the PR title gate. Promoting any of the
three to 🟢 is a future call, not a present miss.

## Coverage by Skill

### prose-standard

Voice and style rules for all written output.

| Rule | Section in skill | Status | Enforced by |
| --- | --- | --- | --- |
| No emdashes (`—`) | Spelling and Locale | 🟢 | `lib/prose/detect.ts` `EMDASH_REGEX` |
| No `\u2014` literal escape | Spelling and Locale | 🟢 | `lib/prose/detect.ts` `EMDASH_ESCAPE_REGEX` |
| No en-dash as emdash | Spelling and Locale | 🚫 | An en-dash is legitimate in numeric ranges (`pages 3–5`); a gate would false-positive. Skill-only. |
| Canadian spelling (curated table) | Words the Gate Flags | 🟢 | `lib/prose/detect.ts` `SPELLING_PAIRS`, bound to the skill table by `tests/lib/prose/spelling-binding.test.ts` |
| Excluded spelling pairs (`licence`, `practice`, `cheque`, `aluminum`, `meter`, `program`, `dialog`) | Words the Gate Flags | 🚫 | Meaning- or POS-dependent; flagging would mark a correct Canadian spelling wrong. Recorded in the skill. |
| No curly quotes | Punctuation | 🟢 | `lib/prose/detect.ts` `CURLY_QUOTE_REGEX` |
| No Unicode ellipsis (`…`) | Punctuation | 🟢 | `lib/prose/detect.ts` `ELLIPSIS_REGEX` |
| No emphasis in running prose | Decoration in Prose | 🚫 | Detecting "running prose" requires judgment about whether a span is a heading, list item or a code lead-in. Skill-only plus resident reminder. |
| No backticks in running prose | Decoration in Prose | 🚫 | Same as above. Backticks are legitimate in lists, code lead-ins and validation evidence. |
| Tone (matter-of-fact, no praise, no apology) | Tone | ⚪ | Judgment. |
| Sentence structure (active voice, plain words) | Grammar and Sentence Structure | ⚪ | Judgment. |
| List hygiene (no orphan items, parallel grammar) | Lists | ⚪ | Judgment for prose; mechanical for Slack only (see `slack-guide`). |
| Headings | Headings | ⚪ | Owned by `markdown-standard`. |
| Commit message prose | Commit Messages | 🟢 | Same prose gate, run by `commit-guardian` over the commit body via `lib/internal/guardian/prose-gate.ts`. |

### github-pr-format

PR description structure and narrative.

| Rule | Section in skill | Status | Enforced by |
| --- | --- | --- | --- |
| Descriptive Title Case title (not conventional commit) | Title | 🟢 | `lib/title/detect.ts` flags the conventional-commit form; the gate runs in `pr-guardian` |
| Title Case enforcement | Title (via `github-cli-convention`) | 🟢 | `lib/title/detect.ts` flags sentence case when lowercase major words number at least two and outnumber the capitalized ones; gated in `pr-guardian`, including title-only edits with no body. A title made mostly of lowercase proper nouns can still false-positive, bounded by the gate relenting on the identical resubmission; over-capitalized minor words stay judgment, skill-only. |
| Closed three-section body set (🌐 Situation / 🔧 Resolution / 🔬 Validation) | Body Structure | 🟢 | `lib/sections/detect.ts` against `PR_SECTIONS`, bound to the skill by `tests/lib/sections/sanctioned.test.ts` |
| Sections in mandated order | Body Structure | 🟢 | `lib/sections/detect.ts` flags `misordered` (R3 in the remediation plan) |
| No invented headings | Body Structure | 🟢 | Same detector, `invented` issue kind |
| URI indexing (issues, files, commits) | URI Indexing | ⚪ | Judgment about what to reference. |
| Self-review comment placement and ranges | Self-Review Comments | ⚪ | Judgment. |
| Prose conventions inside the body | (inherits prose-standard) | 🟢 | `runProseGate` in `pr-guardian` |
| Future work belongs in an issue, not the PR | Body Structure (intro) | ⚪ | The closed section set already removes the temptation; no separate gate needed. |

### github-issue-format

Issue body structure and narrative.

| Rule | Section in skill | Status | Enforced by |
| --- | --- | --- | --- |
| Descriptive Title Case title (not conventional commit) | Title | 🟢 | `lib/title/detect.ts`; gate runs in `issue-guardian` |
| Closed three-section body set (🌐 Situation / 🎯 Outcome / ✅ Acceptance) | Body Structure | 🟢 | `lib/sections/detect.ts` against `ISSUE_SECTIONS`, bound to the skill |
| Sections in mandated order | Body Structure | 🟢 | Same detector |
| No invented headings | Body Structure | 🟢 | Same detector |
| URI indexing | URI Indexing | ⚪ | Judgment. |
| Prose conventions inside the body | (inherits prose-standard) | 🟢 | `runProseGate` in `issue-guardian` |

### commit-format

Commit message structure.

| Rule | Section in skill | Status | Enforced by |
| --- | --- | --- | --- |
| Conventional-commit subject (`type(scope): subject`) | Format / Subject Line | 📋 | `extensions/commit-guardian/validate.ts` `conventionalOk`, shown as a `✓ conventional` / `⚠ not conventional` indicator. Not blocked. |
| Subject ≤ 50 characters | Subject Line | 📋 | Same module, `subjectOk` indicator |
| Body line wrap ≤ 72 characters | Body | 📋 | Same module, `bodyWrapOk` indicator |
| Type from the allowed list | Types | ⚪ | The conventional-commit regex accepts any lowercase word as a type; choosing the right one is judgment. |
| Body says why, not what | Body | ⚪ | Judgment. |
| URI indexing in the body | URI Indexing | ⚪ | Judgment. |
| Breaking-change marker (`!` or `BREAKING CHANGE`) | Breaking Changes | ⚪ | Judgment about whether the change is breaking. |
| Prose conventions in the body | (inherits prose-standard) | 🟢 | `runProseGate` in `commit-guardian` |

### markdown-standard

Markdown structure rules for any markdown file.

| Rule | Section in skill | Status | Enforced by |
| --- | --- | --- | --- |
| Title Case headings (with documented exceptions) | Headings | ⚪ | Detecting "Title Case" mechanically false-positives on proper nouns and acronyms; the exception list itself is judgment. Skill-only. |
| Target line width with exceptions | Line Width | 📋 | Partially: the commit guardian flags body line width as an advisory; markdown files in general are not checked. |
| Reference-style links | Links | ⚪ | Judgment about when an inline link would be unreadable. |
| Fenced code blocks with language tags | Code Blocks | ⚪ | Judgment about which language tag fits. |
| Tables and lists structural shape | Tables / Lists | ⚪ | Judgment. |

### comment-format

PR review comment structure.

| Rule | Section in skill | Status | Enforced by |
| --- | --- | --- | --- |
| Conventional Comments labels (`praise:`, `nitpick:`, `suggestion:`, `issue:`, `question:`, `thought:`, `chore:`, `note:`, `todo:`) | Labels | ⚪ | The label set is fixed but choosing the right label is judgment. |
| Decorations (`(blocking)`, `(non-blocking)`, `(if-minor)`, `(security)`) | Decorations | ⚪ | Judgment about whether a comment blocks the merge. |
| Tone (Canadian-polite, instructional, no praise unless real) | Tone | ⚪ | Judgment. |
| Evidence-based claims | Evidence-Based Comments | ⚪ | Judgment. |
| Prose conventions inside comment bodies | (inherits prose-standard) | 🟢 | `pr-workflow` post action gates the review summary and every comment body via `buildReviewProseGate` |

### slack-guide

Slack message authoring and content.

| Rule | Section in skill | Status | Enforced by |
| --- | --- | --- | --- |
| No markdown image embeds (`![alt](url)`); upload files instead | Unsupported Syntax | 🟢 | `lib/slack/detect.ts` |
| No markdown pipe tables; use the `table` parameter instead | Tables | 🟢 | `lib/slack/detect.ts` |
| Well-formed lists (no orphan items, parallel shape) | Tables / Lists | 🟢 | `lib/slack/detect.ts`, conservative thresholds (runs of two, separator-or-adjacent-rows) |
| No glyph bullets (`•`, `‣`, `◦`, `▪`, `·`); markdown markers (`- `, `* `, `+ `) only | Message Formatting | 🟢 | `lib/slack/detect.ts` flags a run of two glyph-led lines with a distinct instructive message; same run-of-two threshold as the markdown-marker scan |
| Thread replies put the parent ts in `ts`, never `thread_ts` | Reply to that thread saying… | ⚪ | Parameter-usage methodology, not artifact shape. The `ts`/`thread_ts` schema descriptions and the `slack` tool guideline carry it; `thread_ts` without `ts` already fails loudly at the router. |
| Slack mrkdwn dialect (`*bold*`, `_italic_`, `~strike~`) instead of markdown | Text Formatting | 🔇 | `lib/slack/blocks.ts` translates `**bold**` → `*bold*`, `*italic*` → `_italic_`, etc., at send time |
| Slack link syntax (`<url|text>`) instead of markdown | Links and Mentions | 🔇 | `lib/slack/blocks.ts` translates `[text](url)` → `<url|text>` |
| Colour swatch hex codes (`#DA35EA`) get a leading zero-width space to suppress the auto-detected swatch | Avoiding Auto-Detected Colour Swatches | 🔇 | `lib/slack/blocks.ts` inserts a ZWSP before the `#` |
| Prose conventions inside Slack messages | (inherits prose-standard) | 🚫 | Slack messages are casual and the gate scope is the Slack-format check; prose-standard runs in artifacts the user signs their name to (PRs, commits, issues, review comments). |
| Translating user intent to API actions | Translating User Intent | ⚪ | Methodology, not artifact shape. |
| Search operator and ID handling | Search Operators / URL and ID Handling | ⚪ | Methodology. |

### github-cli-convention

Command syntax for `gh` operations.

| Rule | Section in skill | Status | Enforced by |
| --- | --- | --- | --- |
| `--body-file -` heredoc form, never `--body "..."` | Heredoc Syntax / Why --body-file Over --body | 🟢 | `extensions/github-cli-interceptor/patterns.ts` blocks `--body` |
| `--body-file -` (stdin), never `--body-file <path>` | Why --body-file Over --body | 🟢 | Same module blocks file-path form |
| Heredoc must be present when `--body-file -` is used | Heredoc Syntax | 🟢 | Same module blocks bare stdin |
| Quoted heredoc delimiter (`<<'EOF'`, not `<<EOF`) | Heredoc Syntax | 🟢 | `lib/shell/parse.ts` `hasUnquotedHeredoc`, blocked in the guardians |
| Descriptive, not conventional commit | Title Conventions | 🟢 | `lib/title/detect.ts`, gated in pr-guardian and issue-guardian |
| Title Case | Title Conventions | 🟢 | `lib/title/detect.ts` `detectSentenceCase` flags sentence case (lowercase major words at least two and outnumbering the capitalized ones), gated in pr-guardian and issue-guardian, including title-only edits with no body (the parser keeps a null body so the title gate still runs). A title made mostly of lowercase proper nouns can still false-positive, bounded by the gate relenting on the identical resubmission; over-capitalized minor words remain judgment. |
| Title length ≤ 72 characters (upper bound) | Title Conventions | 🟢 | `lib/title/detect.ts` `MAX_TITLE_LENGTH`, gated in pr-guardian and issue-guardian; the skill text is asserted by `tests/lib/title/skill-binding.test.ts` |
| Aim for 50+ characters (lower bound) | Title Conventions | ⚪ | Guidance, not enforced. A short descriptive title ("Add Dark Mode Toggle") is fine; blocking would mark legitimate prose wrong. The skill is explicit about which bound is the wall and which is the nudge. |
| Metadata in separate commands (not packed into `create`) | Metadata in Separate Commands | ⚪ | Judgment about which metadata calls to chain. |
| Line wrapping in bodies | Line Wrapping in Bodies | ⚪ | Judgment. |

### git-cli-convention

Command syntax for `git` operations.

| Rule | Section in skill | Status | Enforced by |
| --- | --- | --- | --- |
| Heredoc commit messages, never long `-m` | Heredoc Syntax for Commits / Why Heredoc Over -m | 🔇 | `extensions/attribution-interceptor` rebuilds every commit it processes (heredoc, `-m`, or `-F <file>`) into the canonical heredoc form via `buildCommitHeredoc`, so the convention is enforced silently in the rewrite. When `--no-attribution` is set the original `-m` form passes through. |
| Quoted heredoc delimiter | Shell Quoting | 🟢 | Same `hasUnquotedHeredoc` check applies to commit heredocs through the guardian |
| One concern per bash call | One Concern Per Bash Call | ⚪ | Judgment about what constitutes "one concern". |

### quest-format

On-disk shape of a quest README and the documents under it.

| Rule | Section in skill | Status | Enforced by |
| --- | --- | --- | --- |
| ID format `PREFIX-YYYYMMDD-XXXXXX` (6-char base-36 upper) | Identifiers | 🟢 | `lib/internal/quest/id.ts` `isId` validates; the discovery walk surfaces directory-name vs id mismatches as errors. |
| Frontmatter required scalars (id, kind, parent, status, priority, rank, started, updated) | Frontmatter | 🟢 | `lib/internal/quest/frontmatter.ts` returns undefined when any required scalar is missing; the discovery walk records the failure. |
| `kind` enum (quest, subquest, sidequest) | Frontmatter | 🟢 | Same parser rejects unknown kinds. |
| `status` enum (active, paused, blocked, concluded, retired) | Frontmatter | 🟢 | Same parser rejects unknown values. |
| `priority` enum (driving, active, queued, bench, someday) | Frontmatter | 🟢 | Same parser rejects unknown values. |
| Alias format `type:value` matching the refs registry | Frontmatter | 🚫 | The parser accepts any `type:value` pair; the refs registry decides at lookup time. Unregistered types simply have no URL. |
| Four mandatory body sections (Summary, Purpose, Cast, Journey) | Body Sections | ⚪ | Skill-only for v1; convention drift would land here first. A content gate over quest READMEs can land later if drift shows up. |
| Section emoji glyphs | Body Sections | ⚪ | Skill-only; the section extractor accepts the headings with or without an emoji prefix. |
| Cast role-prefix bullets | Cast Bullets | ⚪ | The extractor only picks bullets that match the role-prefix pattern; non-matching bullets are silently ignored, so the rule is enforced by what gets indexed but not by a write gate. |
| Journey entry shape (dated bullets, newest first) | Journey Entries | ⚪ | Skill-only. The extractor parses any `- **YYYY-MM-DD**: ...` bullet; ordering is the author's responsibility. |
| Inline link extraction | Inline Links and References | 🚫 | The library indexes what it finds; absence is silent. Skill-only. |
| Prose voice | Voice | 🟢 | `prose-standard` covers it through the existing prose gate. |

### quest-convention

Operational rules for the quest system.

| Rule | Section in skill | Status | Enforced by |
| --- | --- | --- | --- |
| Kind choice (quest vs subquest vs sidequest) | Kind: Quest, Subquest or Sidequest | ⚪ | Judgment. |
| Priority bucket choice | Priority Buckets and Rank | ⚪ | Judgment. |
| Status enum changes only when situation changes | Status and Journey | ⚪ | Judgment. |
| URL-to-quest dedup (load existing instead of creating) | Creating from a URL | 🟢 | The tool's create action checks the alias index and proposes loading when a match exists (planned; partial wiring in place). |
| Quest code lives in a working tree | Focus and the Document Loop | 🟢 | During build, `enforce.ts` allows any write inside a git working tree and blocks only a genuinely homeless write (outside every tree, not scratch or quest-internal) with a `tree-add` remedy. Replaces the old transition refusal and the registered-tree/active-session stand-down. |
| Document scaffolding criteria | When to Scaffold a Document | ⚪ | Judgment. |
| Code-write discipline on focused plan | Focus and the Document Loop | 🟢 | `extensions/quest-workflow/enforce.ts` routes writes through `lib/internal/quest/write-classifier.ts` during plan think/draft and defers only edits to already-tracked code; the plan itself, quest-directory files, scratch and brand-new (untracked) files flow. Bash writes are classified on the stripped skeleton so a read-only command carrying a literal mutating verb is not blocked. |
| Conclude vs Retire | Conclude vs Retire | ⚪ | Judgment. |

## Skills With No Artifact-Shape Rules

These skills exist but are out of scope for the gate matrix. They
teach methodology, navigation or tool usage rather than describing
the shape of an artifact the agent produces. A rule in any of them
is followed by judgment, not by a regex.

- **Methodology guides**: `code-investigation-guide`,
  `code-tdd-guide`, `planning-guide`, `subagent-fleet-guide`,
  `pr-workflow-guide`, `convention-recurrence-sensor-guide`,
  `session-log-guide`.
- **Style standards**: `code-style-standard`,
  `code-review-standard`. These describe how the agent should
  write and review code; the gates do not parse code semantics.
- **Operational conventions**: `git-branch-convention`,
  `git-commit-convention`, `git-rebase-convention`,
  `github-pr-merge-convention`, `github-pr-stack-convention`.
  These govern when and how to perform an operation, not the
  shape of an artifact that goes through a gate.
- **Tool integration guides**: `google-workspace-guide`,
  `slack-guide`'s methodology sections. Translate user intent to
  API calls; not artifact shape.
- **GitHub navigation guides**: `github-project-guide`,
  `github-sub-issue-guide`.
- **Subagent output contracts**: `pr-workflow-council-output`,
  `pr-workflow-critique-output`, `pr-workflow-judge-output`,
  `pr-workflow-stack-judge-output`,
  `pr-workflow-stack-review-output`. Loaded into subagents via
  `--skill`; enforcement is the `verify_output` tool from
  `pr-workflow-verify`, not the main-agent gate stack.

## Why a Coverage Matrix Exists at All

Every gate this package ships came from the same diagnosis: the
skill said the rule plainly, the agent kept breaking it, and the
review panel approved the broken artifact. The remediation was to
detect the violation and block the first offence, pointing at the
skill so the agent fixes the artifact and the user never types the
correction again.

That posture only works if every rule a skill states either has a
gate, has a recorded reason it does not, or is honestly marked as
judgment. Without this matrix, the next title-gate-shaped miss
will slip the same way: a real rule, in a real skill, that nothing
checks, found by accident in a bad artifact months later.

Keep this document current and the gap closes itself.
