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
		// The reviewer's response gets parsed as JSON, so
		// the prompt must explicitly forbid prose-only
		// responses and demand a fenced JSON block.
		const prompt = buildReviewerPrompt({
			prTitle: "Add foo",
			prDescription: "Adds the foo handler",
			files: [file()],
		});
		expect(prompt.toLowerCase()).toContain("json");
		expect(prompt).toMatch(/```json/);
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

	it("documents the finding schema so the model knows what to emit", () => {
		// The prompt must teach the reviewer the shape of
		// a Finding so the parser has something to parse.
		// We assert the load-bearing keys, not the exact prose.
		const prompt = buildReviewerPrompt({
			prTitle: "x",
			prDescription: "",
			files: [file()],
		});
		for (const key of ["label", "subject", "discussion", "location"]) {
			expect(prompt).toContain(key);
		}
	});

	it("instructs the reviewer to call verify_output before ending", () => {
		// Council reviewer subagents get the
		// pr-workflow-verify extension injected so they can
		// validate their JSON against the schema. The prompt
		// must teach the model to USE that tool, otherwise
		// the self-correction loop never starts.
		const prompt = buildReviewerPrompt({
			prTitle: "x",
			prDescription: "",
			files: [file()],
		});
		expect(prompt).toContain("verify_output");
		// The tool needs the stage so the prompt has to
		// tell the model which schema to validate against.
		expect(prompt).toMatch(/stage[=:].?["']?council/i);
	});

	it("embeds the JSON schema for the council output", () => {
		// The model is more reliable when it sees the
		// schema it'll be validated against, not just a
		// hand-rolled example. We pin the load-bearing
		// schema markers rather than the whole stringified
		// JSON to keep this resilient to TypeBox version
		// formatting changes.
		const prompt = buildReviewerPrompt({
			prTitle: "x",
			prDescription: "",
			files: [file()],
		});
		expect(prompt).toMatch(/JSON Schema/i);
		// All twelve Conventional Comments labels appear
		// in the schema's label enum.
		expect(prompt).toContain("praise");
		expect(prompt).toContain("quibble");
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
