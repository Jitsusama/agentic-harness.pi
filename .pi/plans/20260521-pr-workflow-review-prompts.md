## Goal

Improve `pr-workflow` review quality and posting tone.

The reviewer subprocess prompts should explicitly tell reviewers to look for and load relevant project-level or user-level Pi skills that relate to code review and code quality. The review pipeline should also produce final GitHub comments that follow Conventional Comments more faithfully, including label emoji prefixes, and should keep the top-level review body friendly and sparse.

## Skills to Follow

- Follow `security-context` before generating code.
- Follow `code-style-standard` for implementation quality.
- Follow `code-review-standard` for review-quality expectations.
- Follow `comment-format` for Conventional Comments structure.
- Follow `prose-standard` for user-facing copy.
- Follow `git-branch-convention`, `git-cli-convention`, `commit-format` and `git-commit-convention` when committing.

## Context From Research

- Pi skills are progressively disclosed. At startup, Pi lists available skills in the system prompt with names, descriptions and locations. The model must then use `read` to load the full `SKILL.md` when the task matches. Pi docs explicitly note that models do not always load matching skills unless prompted.
- Reviewer subprocesses run as `pi --mode json --no-session -p ...` with the review worktree as `cwd` (`extensions/pr-workflow/reviewer.ts`). Project-level skills in that worktree, plus relevant user-level skills, should be discoverable to the subprocess through Pi's normal skill discovery.
- The current round-1 prompt asks reviewers to cover a broad spectrum of concerns, but it does not tell them to inspect available skills or load quality/review-related project skills (`extensions/pr-workflow/prompts.ts`).
- Stack review, judge and critique prompts all call `reviewerOperatingRules()` but currently use it only for filesystem/tool discipline (`extensions/pr-workflow/stack-review.ts`, `extensions/pr-workflow/judge.ts`, `extensions/pr-workflow/critique.ts`, `extensions/pr-workflow/prompt-operating-rules.ts`). This is the best shared place for general skill-loading guidance.
- Current schemas accept the Conventional Comments labels, including `praise`, `nitpick`, `suggestion`, `issue`, `todo`, `question`, `thought`, `chore`, `note`, `typo`, `polish` and `quibble` (`extensions/pr-workflow/schemas.ts`).
- Current posting only partially follows Conventional Comments. Inline comments render as `**label:** subject`, which omits decorations and differs from the canonical `<label> [decorations]: <subject>` form. File/global/stack findings render into review-body headings (`extensions/pr-workflow/post.ts`).
- The user clarified the desired fallback behaviour: try to fit findings into valid GitHub line ranges first. If no valid line range exists, top-level body text is acceptable as a fallback.
- The user does not want hard-coded references to specific skill names. The prompt should generally direct reviewers to evaluate available project-level and user-level skills whose descriptions relate to reviewing code, code quality, testing, security, style, architecture or repository conventions.

## Progress

Steps use checkboxes. Find the first unchecked step; that's where to start. After completing a step, check it off and commit the plan file update with the implementation work. Do not start the next step until the current one is checked off.

## Approach

Add a shared prompt section for skill discovery and review discipline, then wire it into all reviewer-like prompts. Keep the guidance generic: reviewers should inspect the available skill list already provided by Pi, load relevant project or user skills by path and apply them before reviewing. If they cannot load a relevant skill because the tool palette prevents it, they should say so in warnings rather than silently ignoring it.

Update review-post rendering so comments are closer to canonical Conventional Comments:

- Use `<emoji> <label> [decorations]: <subject>` as the first line.
- Include decorations when present.
- Keep discussion as the body.
- Preserve qualifier and provenance, but keep them visually secondary.

For top-level review bodies, keep the default body friendly and sparse. Inline findings should remain inline. Non-line findings should still be allowed as a fallback, but their body entries should use the same Conventional Comments formatting rather than heading-heavy prose. If the post payload has only inline comments, the top-level review body should be a short friendly sentence, not a detailed council report.

## Proposed Label Emoji Mapping

Use simple, readable emojis that reinforce the label without making comments noisy:

- `praise`: `👏`
- `nitpick`: `🔍`
- `suggestion`: `💡`
- `issue`: `⚠️`
- `todo`: `✅`
- `question`: `❓`
- `thought`: `💭`
- `chore`: `🧹`
- `note`: `📝`
- `typo`: `✏️`
- `polish`: `✨`
- `quibble`: `🤏`

## PR Breakdown

- [x] **PR 1: Skill-Aware Reviewer Prompts**

**What it does:** Adds a shared prompt section that instructs reviewer subprocesses to evaluate available project-level and user-level Pi skills relevant to review and quality, load the matching `SKILL.md` files and apply them before producing findings. Wires this into council, stack review, judge and critique prompts.

**Why separate:** This changes model behaviour without changing posting semantics. It is easy to validate through prompt tests.

**Files:**

- `extensions/pr-workflow/prompt-operating-rules.ts`
- `extensions/pr-workflow/prompts.ts` if a separate review-focus section is clearer than extending operating rules
- `extensions/pr-workflow/stack-review.ts`
- `extensions/pr-workflow/judge.ts`
- `extensions/pr-workflow/critique.ts`
- `tests/extensions/pr-workflow/council-prompt.test.ts`
- `tests/extensions/pr-workflow/stack-review.test.ts`
- `tests/extensions/pr-workflow/judge.test.ts`
- `tests/extensions/pr-workflow/critique.test.ts`

**Test Scenarios:**

- Council prompt tells reviewers to load relevant project-level/user-level Pi skills for review and quality.
- Stack review prompt includes the same skill-loading guidance.
- Judge prompt includes the same skill-loading guidance, because judge may need style/comment guidance while consolidating.
- Critique prompt includes the same skill-loading guidance.
- Prompt wording stays generic and does not name specific skills.
- Existing filesystem-roaming restrictions remain present.

- [x] **PR 2: Conventional Comment Rendering**

**What it does:** Centralizes Conventional Comments rendering for posted comments and body fallback entries. Adds emoji prefixes and decoration rendering. Applies the same formatter to inline comments, file/global fallback body entries and stack fallback body entries.

**Why separate:** This changes GitHub-facing output and deserves focused review and tests.

**Files:**

- `extensions/pr-workflow/post.ts`
- `tests/extensions/pr-workflow/post.test.ts`

**Interfaces:**

- Add a small internal formatter, for example `renderConventionalCommentHeader(finding): string`.
- The formatter takes a finding-like object with `label`, `decorations` and subject text.
- It returns `<emoji> <label> (decorations): <subject>` when decorations exist and `<emoji> <label>: <subject>` otherwise.

**Test Scenarios:**

- Inline comments render with emoji, label, decorations and subject in canonical order.
- Inline comments include the discussion after a blank line.
- Unknown or missing decorations are omitted cleanly.
- Every schema label has a deterministic emoji mapping.
- Existing edit and qualify decisions still override subject/discussion as expected.
- Provenance still appears after the main discussion.

- [ ] **PR 3: Friendlier Sparse Review Body**

**What it does:** Reworks the top-level review body to be friendly and minimal. Inline-only reviews should post a short friendly summary. Non-line findings can still fall back to top-level body text, but they should be compact Conventional Comments entries rather than heavy headings. The body should avoid dumping council mechanics unless the user explicitly supplies a prefix.

**Why separate:** This changes the visible posting experience and may need live validation against GitHub's review API limits.

**Files:**

- `extensions/pr-workflow/post.ts`
- `extensions/pr-workflow/post-gate-render.ts` if the gate copy needs to distinguish inline vs fallback-body findings more clearly
- `tests/extensions/pr-workflow/post.test.ts`
- `tests/extensions/pr-workflow/post-gate-render.test.ts` if gate copy changes

**Test Scenarios:**

- Inline-only payloads produce a short friendly top-level body.
- File-level findings fall back to body entries when no line range exists.
- Global findings fall back to body entries when no line range exists.
- Stack findings that home to the current PR fall back to body entries when no line range exists.
- The generated body does not include judge self-signal by default.
- The generated body does not use the terse `Council review: N finding(s) included` wording by default.
- A caller-supplied body prefix still appears at the top.
- The post gate still shows accurate inline/body/skipped counts.

## Open Questions

- Should praise findings ever post automatically, or should they stay visible in findings view but require explicit user decision like everything else? Current behaviour already requires a decision, so the plan keeps that unchanged.
- Should the final top-level body mention skipped findings at all? Current generated body mentions skipped counts. The proposed default should probably omit this from GitHub and leave skipped details in the local gate/result.

## Risks

- Skill-loading prompts can make reviewers spend more time before reviewing. Mitigation: tell reviewers to load only skills whose descriptions are clearly relevant to code review or quality.
- Reviewers may load global skills when a more specific project skill exists. Mitigation: tell them to prefer project-level skills when both apply.
- Emoji prefixes could feel too playful in serious blocking comments. Mitigation: keep the mapping restrained and put the formal Conventional Comment label immediately after the emoji.
- GitHub body fallback can still be noisy when many non-line findings are endorsed. Mitigation: keep body entries compact and rely on user decisions to avoid posting low-value scope findings.
