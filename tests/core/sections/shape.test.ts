import { describe, expect, it } from "vitest";
import {
	detectShapeViolations,
	formatShapeBlock,
	PR_SECTIONS,
	PR_SHAPE,
} from "../../../lib/core/sections/index.ts";

const [TLDR, PROBLEM, SOLUTION, VALIDATION] = PR_SECTIONS;

/** A body that keeps every rule, to be broken one rule at a time. */
function body(parts: Partial<Record<string, string>> = {}): string {
	const text = {
		[TLDR]: "Merging with a short commit id now works the first time.",
		[PROBLEM]:
			"Merging failed 23 times in two months because GitHub wants the full id.",
		[SOLUTION]:
			"Merge expands a short id to the full one before it asks GitHub, because GitHub accepts only the full id.",
		[VALIDATION]: "A test sends a short id and checks the full one arrives.",
		...parts,
	};
	return PR_SECTIONS.map((h) => `${h}\n\n${text[h]}`).join("\n\n");
}

const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
const rules = (b: string) =>
	detectShapeViolations(b, PR_SHAPE).map((v) => v.rule);

describe("detectShapeViolations", () => {
	it("passes a body that keeps every rule", () => {
		expect(detectShapeViolations(body(), PR_SHAPE)).toEqual([]);
	});

	it("refuses a TL;DR longer than an eight-second read", () => {
		const limit = PR_SHAPE.sections[TLDR]?.words ?? 0;
		const violations = detectShapeViolations(
			body({ [TLDR]: `${words(limit + 1)}.` }),
			PR_SHAPE,
		);
		expect(violations).toContainEqual(
			expect.objectContaining({
				kind: "shape",
				section: TLDR,
				rule: "words",
				limit,
				actual: limit + 1,
			}),
		);
	});

	it("counts sentences, not periods inside abbreviations or code", () => {
		expect(
			rules(
				body({
					[TLDR]: "Short ids, e.g. `abc1234.x`, now merge. That saves a retry.",
				}),
			),
		).not.toContain("sentences");
		expect(rules(body({ [TLDR]: "One. Two. Three." }))).toContain("sentences");
	});

	it("keeps code, links and lists out of the TL;DR", () => {
		expect(
			rules(body({ [TLDR]: "Merge takes `expectedHead` now." })),
		).toContain("codeSpans");
		expect(
			rules(body({ [TLDR]: "Merge now [works][1].\n\n[1]: https://x.test" })),
		).toContain("links");
		expect(rules(body({ [TLDR]: "- merge works\n- lsp works" }))).toContain(
			"bullets",
		);
	});

	it("does not count the issue line or the stack note against the TL;DR", () => {
		const context = [
			"Merging with a short commit id now works the first time.",
			"",
			"Part of #482",
			"",
			"> [!NOTE]",
			"> 👈 #10 · 👇 **#11** · 👉 _next not yet created_",
		].join("\n");
		expect(detectShapeViolations(body({ [TLDR]: context }), PR_SHAPE)).toEqual(
			[],
		);
	});

	it("keeps the Problem in prose", () => {
		expect(rules(body({ [PROBLEM]: "- it failed\n- it hung" }))).toContain(
			"bullets",
		);
	});

	it("refuses a Solution that lists artifacts instead of behaviour", () => {
		for (const label of ["**Docs:**", "Tests:", "Files:", "README:"]) {
			expect(
				rules(
					body({
						[SOLUTION]: `Merge expands short ids.\n\n- ${label} updated the guide.`,
					}),
				),
			).toContain("artifactLists");
		}
	});

	it("allows a dependency or setting labelled as such, since it is what the reader must act on", () => {
		for (const label of ["**Dependency:**", "Config:"]) {
			expect(
				rules(
					body({
						[SOLUTION]: `Merge expands short ids.\n\n- ${label} core moves to 0.9.0, which renames the sections.`,
					}),
				),
			).not.toContain("artifactLists");
		}
	});

	it("allows a Solution bullet that merely mentions tests", () => {
		expect(
			rules(
				body({
					[SOLUTION]:
						"Merge expands short ids.\n\n- Tests that spawn node run in their own lane.",
				}),
			),
		).not.toContain("artifactLists");
	});

	it("caps the bullets a Solution may use", () => {
		const limit = PR_SHAPE.sections[SOLUTION]?.bullets ?? 0;
		const list = Array.from({ length: limit + 1 }, (_, i) => `- item ${i}`);
		expect(rules(body({ [SOLUTION]: list.join("\n") }))).toContain("bullets");
	});

	it("refuses a run-on sentence anywhere, quoting its start", () => {
		const limit = PR_SHAPE.sentenceWords ?? 0;
		const sentence = `The tool ${words(limit)} at last.`;
		const violations = detectShapeViolations(
			body({ [VALIDATION]: sentence }),
			PR_SHAPE,
		);
		const runOn = violations.find((v) => v.rule === "sentenceWords");
		expect(runOn?.section).toBe(VALIDATION);
		expect(runOn?.excerpt).toMatch(/^The tool word/);
	});

	it("ends a sentence before one that opens with a lowercase name", () => {
		const half = words(25);
		const two = `The board ${half} now. niri draws ${half} again.`;
		expect(rules(body({ [SOLUTION]: two }))).not.toContain("sentenceWords");
	});

	it("treats a semicolon chain as one sentence", () => {
		const half = words(25);
		expect(rules(body({ [VALIDATION]: `${half}; ${half}.` }))).toContain(
			"sentenceWords",
		);
	});

	it("does not count a fenced block or the link footer as prose", () => {
		const limit = PR_SHAPE.sections[VALIDATION]?.words ?? 0;
		const validation = [
			"Output from the live run:",
			"",
			"```text",
			words(limit + 10),
			"```",
			"",
			"[1]: https://example.test/a/very/long/url",
		].join("\n");
		expect(
			detectShapeViolations(body({ [VALIDATION]: validation }), PR_SHAPE),
		).toEqual([]);
	});

	it("refuses an empty section", () => {
		expect(rules(body({ [PROBLEM]: "" }))).toContain("empty");
	});

	it("refuses anything above the TL;DR", () => {
		const violations = detectShapeViolations(
			`Part of #482\n\n${body()}`,
			PR_SHAPE,
		);
		expect(violations).toContainEqual(
			expect.objectContaining({ rule: "above" }),
		);
	});

	it("leaves sections it has no rules for alone", () => {
		expect(detectShapeViolations("### Notes\n\n- a\n- b", PR_SHAPE)).toEqual(
			[],
		);
	});
});

describe("formatShapeBlock", () => {
	it("says nothing when the body keeps its shape", () => {
		expect(formatShapeBlock([], "pull request", "github-pr-format")).toBe("");
	});

	it("names the section, the rule, the limit and what was found", () => {
		const limit = PR_SHAPE.sections[TLDR]?.words ?? 0;
		const message = formatShapeBlock(
			detectShapeViolations(body({ [TLDR]: `${words(limit + 5)}.` }), PR_SHAPE),
			"pull request",
			"github-pr-format",
		);
		expect(message).toContain("TL;DR");
		expect(message).toContain(`${limit + 5} words`);
		expect(message).toContain(String(limit));
		expect(message).toContain("github-pr-format");
	});

	it("says how many words to cut", () => {
		const limit = PR_SHAPE.sections[SOLUTION]?.words ?? 0;
		const sentences = Array.from({ length: limit / 20 }, () => `${words(20)}.`);
		const solution = `${sentences.join(" ")} Three more words.`;
		const message = formatShapeBlock(
			detectShapeViolations(body({ [SOLUTION]: solution }), PR_SHAPE),
			"pull request",
			"github-pr-format",
		);
		expect(message).toMatch(/cut 3 words/i);
	});
});
