import { describe, expect, it } from "vitest";
import { buildReviewerPrompt } from "../../../extensions/pr-workflow/prompts.js";
import type { DiffFile } from "../../../lib/internal/github/diff.js";

/**
 * The prompt drives every reviewer in round 1. Tests pin
 * the structural contract: what the model receives, in
 * what order. We don't pin the exact prose (that would
 * force test churn on every wording tweak), but we do pin
 * the load-bearing pieces a reviewer needs to do its job.
 */

function file(overrides: Partial<DiffFile> = {}): DiffFile {
	return {
		path: "src/foo.ts",
		status: "modified",
		additions: 1,
		deletions: 0,
		hunks: [
			{
				oldStart: 1,
				oldCount: 0,
				newStart: 1,
				newCount: 1,
				header: "@@ -1,0 +1,1 @@",
				lines: [
					{
						type: "added",
						content: "console.log('hi');",
						oldLineNumber: null,
						newLineNumber: 1,
					},
				],
			},
		],
		...overrides,
	};
}

describe("buildReviewerPrompt", () => {
	it("instructs the reviewer to output JSON only", () => {
		// The reviewer's response gets parsed as JSON. The
		// prompt body still mentions JSON output, but the
		// exact shape and verify protocol live in the
		// pr-workflow-council-output skill that gets loaded
		// into the subagent.
		const prompt = buildReviewerPrompt({
			prTitle: "Add foo",
			prDescription: "Adds the foo handler",
			files: [file()],
		});
		expect(prompt.toLowerCase()).toContain("json");
	});

	it("includes the PR title and description as context", () => {
		// Title and description shape what the reviewer
		// thinks the change is for. Missing them produces
		// findings disconnected from intent.
		const prompt = buildReviewerPrompt({
			prTitle: "Improve auth flow",
			prDescription: "Switches from sessions to JWT.",
			files: [file()],
		});
		expect(prompt).toContain("Improve auth flow");
		expect(prompt).toContain("Switches from sessions to JWT.");
	});

	it("includes each changed file's path and hunks", () => {
		// Reviewer needs to see the diff. The prompt
		// renders each file as a diff block keyed by path.
		const prompt = buildReviewerPrompt({
			prTitle: "Multi",
			prDescription: "",
			files: [
				file({ path: "src/a.ts" }),
				file({
					path: "src/b.ts",
					hunks: [
						{
							oldStart: 1,
							oldCount: 1,
							newStart: 1,
							newCount: 1,
							header: "@@ -1,1 +1,1 @@",
							lines: [
								{
									type: "removed",
									content: "old line",
									oldLineNumber: 1,
									newLineNumber: null,
								},
								{
									type: "added",
									content: "new line",
									oldLineNumber: null,
									newLineNumber: 1,
								},
							],
						},
					],
				}),
			],
		});
		expect(prompt).toContain("src/a.ts");
		expect(prompt).toContain("src/b.ts");
		expect(prompt).toContain("+new line");
		expect(prompt).toContain("-old line");
	});

	it("omits generated files from the diff but names them in a note", () => {
		// Reviewers should not spend attention or prompt
		// budget on generated output. The diff drops the
		// lockfile while a note tells the reviewer it exists.
		const prompt = buildReviewerPrompt({
			prTitle: "Bump deps",
			prDescription: "",
			files: [file({ path: "src/a.ts" }), file({ path: "pnpm-lock.yaml" })],
		});
		expect(prompt).toContain("Omitted generated files");
		expect(prompt).toContain("pnpm-lock.yaml");
		expect(prompt).toContain("src/a.ts");
		// The lockfile's diff body is not rendered.
		expect(prompt).not.toContain("## Diff\n\npnpm-lock.yaml");
	});

	it("shows every file when they are all generated rather than blanking the diff", () => {
		// If filtering would leave nothing to review, fall
		// back to the full list so the reviewer is never
		// handed an empty diff.
		const prompt = buildReviewerPrompt({
			prTitle: "Lockfile only",
			prDescription: "",
			files: [file({ path: "pnpm-lock.yaml" })],
		});
		expect(prompt).not.toContain("Omitted generated files");
		expect(prompt).toContain("pnpm-lock.yaml");
		expect(prompt).not.toContain("(no files changed)");
	});

	it("renders new-side anchorable line ranges separately from old-side", () => {
		// Council finding [26]: don't mix old- and new-side
		// line numbers in the same range list. Reviewers need
		// to know which side a number refers to so they pick
		// the right `side` for the finding.
		const prompt = buildReviewerPrompt({
			prTitle: "x",
			prDescription: "",
			files: [
				file({
					path: "src/b.ts",
					hunks: [
						{
							oldStart: 5,
							oldCount: 1,
							newStart: 5,
							newCount: 1,
							header: "@@ -5,1 +5,1 @@",
							lines: [
								{
									type: "removed",
									content: "old",
									oldLineNumber: 5,
									newLineNumber: null,
								},
								{
									type: "added",
									content: "new",
									oldLineNumber: null,
									newLineNumber: 5,
								},
							],
						},
					],
				}),
			],
		});
		expect(prompt).toContain("## Anchorable line ranges");
		expect(prompt).toContain("src/b.ts:");
		expect(prompt).toMatch(/src\/b\.ts:.*new 5.*old 5/);
	});

	it("points the reviewer at the council-output skill for the contract", () => {
		// The output shape (location kinds, label vocabulary,
		// threadRelation, etc.) lives in the skill so the
		// schema source of truth doesn't drift across the
		// prompt body. The prompt only needs to name the
		// skill and the subagent loads it via --skill.
		const prompt = buildReviewerPrompt({
			prTitle: "x",
			prDescription: "",
			files: [file()],
		});
		expect(prompt).toContain("pr-workflow-council-output");
	});

	it("instructs the reviewer to call verify_output before ending", () => {
		// Council reviewer subagents get the
		// pr-workflow-council-verify extension injected so
		// they can validate their JSON against the schema.
		// The prompt body names the tool; the council-output
		// skill teaches the protocol in detail.
		const prompt = buildReviewerPrompt({
			prTitle: "x",
			prDescription: "",
			files: [file()],
		});
		expect(prompt).toContain("verify_output");
	});

	it("instructs reviewer tools to stay inside the worktree", () => {
		const prompt = buildReviewerPrompt({
			prTitle: "x",
			prDescription: "",
			files: [file()],
		});
		expect(prompt).toContain("current working directory");
		expect(prompt).toContain("Stay inside");
		expect(prompt).toContain("Do not search `/`");
		expect(prompt).toContain("`/Users`");
		expect(prompt).toContain("`$HOME`");
		expect(prompt).toContain("Never run commands like `find /`");
		expect(prompt).toContain("Do not roam the filesystem");
		expect(prompt).toContain("`rg`");
	});

	it("instructs reviewers to load relevant review and quality skills generically", () => {
		const prompt = buildReviewerPrompt({
			prTitle: "x",
			prDescription: "",
			files: [file()],
		});
		expect(prompt).toContain("Pi skills");
		expect(prompt).toContain("project-level");
		expect(prompt).toContain("user-level");
		expect(prompt).toContain("SKILL.md");
		expect(prompt).toContain("code review");
		expect(prompt).toContain("code quality");
		expect(prompt).not.toContain("code-review-standard");
		expect(prompt).not.toContain("comment-format");
	});

	it("defines the universal review quality bar and discovery method", () => {
		const prompt = buildReviewerPrompt({
			prTitle: "x",
			prDescription: "",
			files: [file()],
		});
		expect(prompt).toContain("Review quality standard");
		expect(prompt).toContain("infrastructure as code");
		expect(prompt).toContain("technical docs");
		expect(prompt).toContain("A finding matters when");
		expect(prompt).toContain(
			"Review changed behaviour, not just changed lines",
		);
		expect(prompt).toContain("Do not flag pure preference");
		expect(prompt).toContain("Council discovery objective");
		expect(prompt).toContain("noisy discovery round");
		expect(prompt).toContain("Useful noise has evidence");
	});

	it("includes provider review context when supplied", () => {
		const prompt = buildReviewerPrompt({
			prTitle: "x",
			prDescription: "",
			files: [file()],
			promptAddendum: "Use the repo's generated-code review rules.",
		});
		expect(prompt).toContain("Provider review context");
		expect(prompt).toContain("generated-code review rules");
	});

	it("keeps Conventional Comments labels in the role narrative", () => {
		// The schema is taught by the council-output skill,
		// but the prompt body still names the label
		// vocabulary in the discovery instructions so the
		// reviewer thinks in those terms from the start and
		// not just at output time. Pin the canonical labels
		// and confirm the deprecated ones are absent.
		const prompt = buildReviewerPrompt({
			prTitle: "x",
			prDescription: "",
			files: [file()],
		});
		expect(prompt).toContain("praise");
		expect(prompt).toContain("note");
		expect(prompt).not.toContain("typo");
		expect(prompt).not.toContain("polish");
		expect(prompt).not.toContain("quibble");
	});

	it("handles an empty file list without crashing", () => {
		// Pathological input shouldn't blow up the prompt
		// builder. The model will just see "no files" and
		// report nothing.
		const prompt = buildReviewerPrompt({
			prTitle: "Empty",
			prDescription: "",
			files: [],
		});
		expect(typeof prompt).toBe("string");
		expect(prompt.length).toBeGreaterThan(0);
	});
});
