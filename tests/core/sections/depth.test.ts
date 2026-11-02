import { describe, expect, it } from "vitest";
import {
	type ChangeSize,
	detectBodyViolations,
	detectSectionViolations,
	detectShapeViolations,
	formatShapeBlock,
	PR_SECTIONS,
	PR_SHAPE,
	readPrFields,
	reviseFields,
	usesDepth,
} from "../../../lib/core/sections/index.ts";

const [TLDR, PROBLEM, SOLUTION, VALIDATION] = PR_SECTIONS;
const DEPTH = PR_SHAPE.depth;
if (DEPTH === undefined)
	throw new Error("the PR shape gives large changes no depth");

const LARGE: ChangeSize = { lines: DEPTH.fromLines };
const SMALL: ChangeSize = { lines: 812 };

const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");

/** A part: a subheading and a paragraph under it. */
const part = (
	title: string,
	text = "The sequencer orders every write before it lands.",
) => `#### ${title}\n\n${text}`;

const TABLE = [
	"| Measure | Before | After |",
	"| --- | --- | --- |",
	"| Push, p50 | 410 ms | 120 ms |",
	"| Fetch, p50 | 95 ms | 60 ms |",
].join("\n");

/** A large change's body: openings within today's ceilings, parts below them. */
function deep(parts: Partial<Record<string, string>> = {}): string {
	const text = {
		[TLDR]:
			"Switched repositories now commit by creating their next log record, 3 times faster.",
		[PROBLEM]: `Every commit took a lock across three stores, so pushes queued.\n\n${part("Why the Lock Was There")}`,
		[SOLUTION]: `A commit now writes one log record, and readers build the rest from it.\n\n${part("The Sequencer")}\n\n${part("The Reader")}`,
		[VALIDATION]: `Seven measured results back it, and two limits remain.\n\n${part("Measured", `${TABLE}\n\nThe measures ran on one machine, so a loaded fleet is not exercised.`)}`,
		...parts,
	};
	return PR_SECTIONS.map((h) => `${h}\n\n${text[h]}`).join("\n\n");
}

const rules = (body: string, size?: ChangeSize) =>
	detectShapeViolations(body, PR_SHAPE, size).map((v) => v.rule);

describe("a large change's depth", () => {
	it("lets a change past the line carry parts below each opening", () => {
		expect(detectShapeViolations(deep(), PR_SHAPE, LARGE)).toEqual([]);
	});

	it("holds each opening to the ordinary ceiling", () => {
		const limit = PR_SHAPE.sections[SOLUTION]?.words ?? 0;
		const violations = detectShapeViolations(
			deep({ [SOLUTION]: `${words(limit + 1)}.\n\n${part("The Sequencer")}` }),
			PR_SHAPE,
			LARGE,
		);
		expect(violations).toContainEqual(
			expect.objectContaining({ section: SOLUTION, rule: "words", limit }),
		);
	});

	it("still needs an opening above the first part", () => {
		expect(rules(deep({ [SOLUTION]: part("The Sequencer") }), LARGE)).toContain(
			"empty",
		);
	});

	it("caps how many parts a section may have, and how long each may be", () => {
		const many = Array.from({ length: DEPTH.parts + 1 }, (_, i) =>
			part(`Part ${i}`),
		).join("\n\n");
		expect(
			rules(deep({ [SOLUTION]: `An opening.\n\n${many}` }), LARGE),
		).toContain("parts");

		const long = detectShapeViolations(
			deep({
				[SOLUTION]: `An opening.\n\n${part("The Sequencer", `${words(DEPTH.partWords + 1)}.`)}`,
			}),
			PR_SHAPE,
			LARGE,
		);
		expect(long).toContainEqual(
			expect.objectContaining({
				section: `${SOLUTION} / The Sequencer`,
				rule: "words",
				limit: DEPTH.partWords,
			}),
		);
	});

	it("holds every part to the sentence ceiling and refuses an artifact list", () => {
		expect(
			rules(
				deep({ [SOLUTION]: `An opening.\n\n${part("Runs", `${words(41)}.`)}` }),
				LARGE,
			),
		).toContain("sentenceWords");
		expect(
			rules(
				deep({
					[SOLUTION]: `An opening.\n\n${part("Files", "- Tests: added.")}`,
				}),
				LARGE,
			),
		).toContain("artifactLists");
	});

	it("refuses parts for a change under the line, saying how big it is", () => {
		const violations = detectShapeViolations(deep(), PR_SHAPE, SMALL);
		expect(violations).toContainEqual(
			expect.objectContaining({ section: SOLUTION, rule: "depth", actual: 2 }),
		);
		expect(
			formatShapeBlock(violations, "pull request", "github-pr-format"),
		).toContain("812 changed lines");
	});

	it("says why when the size could not be measured, and holds the ordinary shape", () => {
		const why =
			"the git provider does not report how many lines a change touches";
		const violations = detectShapeViolations(deep(), PR_SHAPE, {
			unknown: why,
		});
		expect(violations.map((v) => v.rule)).toContain("depth");
		expect(
			formatShapeBlock(violations, "pull request", "github-pr-format"),
		).toContain(why);
	});

	it("points a path that never measures to the one that does", () => {
		const said = formatShapeBlock(
			detectShapeViolations(deep(), PR_SHAPE),
			"pull request",
			"github-pr-format",
		);
		expect(said).toContain("review_offer");
	});

	it("tells a large change from an ordinary one only by its parts", () => {
		expect(usesDepth(deep(), PR_SHAPE)).toBe(true);
		expect(
			usesDepth(
				deep({
					[PROBLEM]: "Pushes queued.",
					[SOLUTION]: "One record.",
					[VALIDATION]: "Measured.",
				}),
				PR_SHAPE,
			),
		).toBe(false);
	});
});

describe("a large change's results table", () => {
	const validation = (
		table: string,
		after = "\n\nThe measures ran on one machine.",
	) =>
		deep({
			[VALIDATION]: `Seven results back it.\n\n${part("Measured", `${table}${after}`)}`,
		});

	it("counts a table by its rows, not as one long sentence", () => {
		const rows = Array.from(
			{ length: DEPTH.tableRows },
			(_, i) => `| Case ${i} | ${i} ms |`,
		);
		const table = ["| Case | Time |", "| --- | --- |", ...rows].join("\n");
		expect(detectShapeViolations(validation(table), PR_SHAPE, LARGE)).toEqual(
			[],
		);
	});

	it("caps its rows and its cells, and wants a number in every row", () => {
		const rows = Array.from(
			{ length: DEPTH.tableRows + 1 },
			(_, i) => `| Case ${i} | ${i} ms |`,
		);
		expect(
			rules(
				validation(["| Case | Time |", "| --- | --- |", ...rows].join("\n")),
				LARGE,
			),
		).toContain("tableRows");
		expect(
			rules(
				validation(
					`| Case | Time |\n| --- | --- |\n| ${words(DEPTH.cellWords + 1)} | 4 ms |`,
				),
				LARGE,
			),
		).toContain("cellWords");
		expect(
			rules(
				validation("| Case | Time |\n| --- | --- |\n| Push | faster |"),
				LARGE,
			),
		).toContain("tableNumbers");
	});

	it("wants a sentence after it saying where the checks stop", () => {
		expect(rules(validation(TABLE, ""), LARGE)).toContain("tableAfter");
	});

	it("keeps tables out of a large Problem and Solution", () => {
		expect(
			rules(
				deep({
					[SOLUTION]: `An opening.\n\n${part("Parts", `${TABLE}\n\nEach part is one crate.`)}`,
				}),
				LARGE,
			),
		).toContain("tablePlace");
	});
});

describe("a large description stands alone", () => {
	it("refuses a code span or a link to a repository document", () => {
		expect(
			rules(
				deep({
					[PROBLEM]: `Pushes queued; see \`docs/history/one-log.md\`.\n\n${part("Why")}`,
				}),
				LARGE,
			),
		).toContain("docLinks");
		expect(
			rules(
				deep({
					[SOLUTION]: `One record.\n\n${part("More", "Read [the design](docs/design.md#log) first.")}`,
				}),
				LARGE,
			),
		).toContain("docLinks");
	});
});

describe("headings inside a section", () => {
	it("reads a part as part of its section, not a heading of its own", () => {
		expect(detectSectionViolations(deep(), PR_SECTIONS, DEPTH)).toEqual([]);
	});

	it("still refuses a subheading where no depth is given", () => {
		const body = deep({
			[TLDR]: `Switched repositories commit faster.\n\n${part("Aside")}`,
		});
		expect(detectSectionViolations(body, PR_SECTIONS, DEPTH)).toContainEqual(
			expect.objectContaining({ issue: "invented", found: "#### Aside" }),
		);
	});

	it("leaves an issue body, which has no depth, as it was", () => {
		const issue =
			"### 🌐 Situation\n\nA.\n\n#### Aside\n\nB.\n\n### 🎯 Outcome\n\nC.\n\n### ✅ Acceptance\n\nD.";
		expect(
			detectBodyViolations(issue, {
				sanctioned: ["### 🌐 Situation", "### 🎯 Outcome", "### ✅ Acceptance"],
			}),
		).toContainEqual(
			expect.objectContaining({ issue: "invented", found: "#### Aside" }),
		);
	});

	it("keeps a section's parts when its fields are read back and revised", () => {
		const { fields } = readPrFields(deep());
		expect(fields.solution).toContain("#### The Reader");
		const revised = reviseFields(deep(), {
			tldr: "Commits are now 3 times faster.",
		});
		expect(revised).toContain("#### The Sequencer");
		expect(revised).toContain("#### Measured");
	});
});
