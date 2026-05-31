import { describe, expect, it } from "vitest";
import {
	buildThreadAuditPrompt,
	parseThreadAuditOutput,
} from "../../../extensions/pr-workflow/thread-audit.js";
import type { ReviewThread } from "../../../extensions/pr-workflow/threads.js";

function thread(over: Partial<ReviewThread> = {}): ReviewThread {
	return {
		id: "T_1",
		kind: "review-thread",
		isResolved: false,
		isOutdated: false,
		path: "src/auth.ts",
		line: 42,
		comments: [
			{
				id: "C_1",
				author: "reviewer",
				body: "This field should be renamed.",
				createdAt: "2026-01-01T00:00:00Z",
				url: "https://example/c1",
			},
		],
		...over,
	};
}

function block(obj: unknown): string {
	return ["```json", JSON.stringify(obj), "```"].join("\n");
}

describe("parseThreadAuditOutput", () => {
	it("reads well-formed per-thread verdicts", () => {
		const out = parseThreadAuditOutput(
			block({
				verdicts: [
					{
						threadId: "T_kwabc",
						disposition: "addressed",
						rationale: "PR #43 downstream renames the field as asked.",
					},
					{
						threadId: "T_kwdef",
						disposition: "valid",
						rationale: "The null check is genuinely missing here.",
					},
				],
			}),
		);
		expect(out.warnings).toEqual([]);
		expect(out.verdicts).toHaveLength(2);
		expect(out.verdicts[0]).toEqual({
			threadId: "T_kwabc",
			disposition: "addressed",
			rationale: "PR #43 downstream renames the field as asked.",
		});
		expect(out.verdicts[1].disposition).toBe("valid");
	});

	it("warns and yields nothing when there is no JSON block", () => {
		const out = parseThreadAuditOutput("I could not produce JSON.");
		expect(out.verdicts).toEqual([]);
		expect(out.warnings).toHaveLength(1);
	});

	it("skips a malformed verdict but keeps the good ones", () => {
		const out = parseThreadAuditOutput(
			block({
				verdicts: [
					{ threadId: "T_ok", disposition: "unclear", rationale: "hmm" },
					{ threadId: "T_bad", disposition: "nonsense", rationale: "x" },
					{ threadId: "T_blank", disposition: "valid", rationale: "   " },
				],
			}),
		);
		expect(out.verdicts.map((v) => v.threadId)).toEqual(["T_ok"]);
		expect(out.warnings).toHaveLength(2);
	});

	it("treats a non-object top level as empty with a warning", () => {
		const out = parseThreadAuditOutput(block([1, 2, 3]));
		expect(out.verdicts).toEqual([]);
		expect(out.warnings).toHaveLength(1);
	});
});

describe("buildThreadAuditPrompt", () => {
	it("renders each thread with its id, anchor and comments", () => {
		const prompt = buildThreadAuditPrompt({
			threads: [thread()],
			stack: [],
		});
		expect(prompt).toContain("T_1");
		expect(prompt).toContain("src/auth.ts:42");
		expect(prompt).toContain("This field should be renamed.");
		expect(prompt).toMatch(/addressed/);
		expect(prompt).toMatch(/valid/);
		expect(prompt).toMatch(/unclear/);
		// Standalone PR gets the no-stack note.
		expect(prompt).toMatch(/standalone/i);
	});

	it("renders the stack with the cursor marked", () => {
		const prompt = buildThreadAuditPrompt({
			threads: [thread()],
			stack: [
				{ number: 42, title: "Add auth", isCursor: true },
				{ number: 43, title: "Rename the field", isCursor: false },
			],
		});
		expect(prompt).toContain("#42: Add auth (this PR)");
		expect(prompt).toContain("#43: Rename the field");
	});

	it("asks for the verdict JSON shape", () => {
		const prompt = buildThreadAuditPrompt({ threads: [thread()], stack: [] });
		expect(prompt).toContain("verdicts");
		expect(prompt).toContain("disposition");
		expect(prompt).toContain("rationale");
	});
});
