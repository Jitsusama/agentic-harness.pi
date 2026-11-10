import { describe, expect, it } from "vitest";
import {
	itemOf,
	linesHolding,
	outlineOf,
	replaceSection,
	sectionOf,
	setCheckbox,
	splitAtBody,
	subsectionOf,
} from "../../../../lib/internal/quest/body-edits.ts";

const PLAN = [
	"# The Plan",
	"",
	"## Work",
	"",
	"- [ ] Core: prune fetch and content check",
	"- [ ] Restore: one recording helper",
	"- [x] Restore the docs",
	"",
	"```md",
	"- [ ] not an item, an example",
	"## Not a heading",
	"```",
	"",
	"## 🎯 Purpose",
	"",
	"Old purpose.",
	"",
	"## 📜 Journey",
	"",
	"- an entry",
	"",
].join("\n");

describe("splitting a document at its body", () => {
	it("keeps the front matter exactly as written", () => {
		const text = "---\nid: X\nstage:   build\n---\n# Title\n";
		const { head, body } = splitAtBody(text);
		expect(head).toBe("---\nid: X\nstage:   build\n---\n");
		expect(body).toBe("# Title\n");
		expect(head + body).toBe(text);
	});

	it("treats a document with no front matter as all body", () => {
		expect(splitAtBody("# Title\n")).toEqual({ head: "", body: "# Title\n" });
	});
});

describe("ticking a checkbox", () => {
	it("ticks the item a unique prefix names", () => {
		const result = setCheckbox(PLAN, "core:", true);
		if (!result.ok) throw new Error(result.reason);
		expect(result).toMatchObject({ changed: true });
		expect(result.body).toContain("- [x] Core: prune fetch and content check");
		expect(result.body).toContain("- [ ] Restore: one recording helper");
	});

	it("prefers an exact match over a longer item it prefixes", () => {
		const body = "- [ ] Docs\n- [ ] Docs and skill\n";
		const result = setCheckbox(body, "docs", true);
		if (!result.ok) throw new Error(result.reason);
		expect(result.body).toBe("- [x] Docs\n- [ ] Docs and skill\n");
	});

	it("refuses when several items fit, and names them", () => {
		const result = setCheckbox(PLAN, "restore", true);
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("expected a refusal");
		expect(result.reason).toContain("2 items fit");
		expect(result.reason).toContain("- 3. Restore the docs");
	});

	it("refuses an item nothing reads, listing what does", () => {
		const result = setCheckbox(PLAN, "deploy", true);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.reason).toContain("- 1. Core: prune fetch and content check");
	});

	it("leaves code examples alone", () => {
		const result = setCheckbox(PLAN, "not an item", true);
		expect(result).toMatchObject({ ok: false });
	});

	it("names an item by the words it shows, not its markdown", () => {
		const body = [
			"- [ ] **R5. m569: capture, then restart leafd (D6).** S1 first.",
			"- [ ] Take `core` 0.13.0 from [npm](https://npmjs.com)",
			"- [ ] Leave *.ts globs and snake__case alone",
			"",
		].join("\n");

		const labelled = setCheckbox(body, "R5. m569", true);
		const coded = setCheckbox(body, "take core 0.13.0 from npm", true);
		const literal = setCheckbox(body, "Leave *.ts globs and snake__case", true);

		for (const result of [labelled, coded, literal]) {
			if (!result.ok) throw new Error(result.reason);
			expect(result).toMatchObject({ changed: true });
		}
		expect(labelled.ok && labelled.line).toMatch(/^- \[x\] \*\*R5\./);
	});

	it("unticks, and says when nothing needed changing", () => {
		const unticked = setCheckbox(PLAN, "restore the docs", false);
		if (!unticked.ok) throw new Error(unticked.reason);
		expect(unticked.body).toContain("- [ ] Restore the docs");
		const again = setCheckbox(unticked.body, "restore the docs", false);
		if (!again.ok) throw new Error(again.reason);
		expect(again).toMatchObject({ changed: false });
	});
});

describe("replacing a section", () => {
	it("replaces a section found by its words, emoji or not", () => {
		const result = replaceSection(PLAN, "purpose", "New purpose.\n");
		if (!result.ok) throw new Error(result.reason);
		expect(result.body).toContain(
			"## 🎯 Purpose\n\nNew purpose.\n\n## 📜 Journey",
		);
		expect(result.body).not.toContain("Old purpose.");
	});

	it("skips a heading inside fenced code", () => {
		const result = replaceSection(PLAN, "not a heading", "x");
		expect(result).toMatchObject({ ok: false });
	});

	it("keeps the final newline when the section is the last", () => {
		const result = replaceSection("## A\n\nold\n", "A", "new");
		if (!result.ok) throw new Error(result.reason);
		expect(result.body).toBe("## A\n\nnew\n");
	});

	it("never rewrites Journey", () => {
		const result = replaceSection(PLAN, "Journey", "- gone");
		if (result.ok) throw new Error("expected a refusal");
		expect(result.reason).toContain("journal");
	});

	it("refuses text that would split the section", () => {
		const result = replaceSection(PLAN, "Purpose", "Text\n\n## Extra\n");
		expect(result).toMatchObject({ ok: false });
	});

	describe("in a README", () => {
		const README = [
			"# A Quest",
			"",
			"## \u{1F4DC} Summary",
			"",
			"What it is.",
			"",
			"## \u{1F304} Journey",
			"",
			"See attachments/journey.md.",
			"",
			"## \u{1F3C6} Outcomes",
			"",
			"What landed.",
			"",
		].join("\n");

		it("adds an optional section in its place, with its glyph", () => {
			const result = replaceSection(
				README,
				"Spirit",
				"The north star.",
				"readme",
			);
			if (!result.ok) throw new Error(result.reason);
			expect(result).toMatchObject({ added: true });
			expect(result.body).toContain(
				"See attachments/journey.md.\n\n## \u{1F525} Spirit\n\nThe north star.\n\n## \u{1F3C6} Outcomes",
			);
		});

		it("adds the last one at the end", () => {
			const result = replaceSection(README, "context", "Background.", "readme");
			if (!result.ok) throw new Error(result.reason);
			expect(result.body).toMatch(
				/What landed\.\n\n## \u{1F3F0} Context\n\nBackground\.\n$/u,
			);
		});

		it("refuses a heading the format does not name, saying what it can gain", () => {
			const result = replaceSection(README, "Kept Outcomes", "x", "readme");
			if (result.ok) throw new Error("expected a refusal");
			expect(result.reason).toContain(
				"A README gains only Milestones, Spirit, Outcomes, Context.",
			);
		});

		it("never adds a mandatory section it lacks", () => {
			const result = replaceSection(README, "Cast", "- **owner**: x", "readme");
			expect(result).toMatchObject({ ok: false });
		});
	});

	it("names the sections there are when the one asked for is not", () => {
		const result = replaceSection(PLAN, "Outcomes", "x");
		if (result.ok) throw new Error("expected a refusal");
		expect(result.reason).toContain("Work, 🎯 Purpose, 📜 Journey");
	});
});

const NUMBERED = [
	"# Steps",
	"",
	"## Work",
	"",
	"- [x] 7. **Write the tests**",
	"  - Landed as #12, with:",
	"",
	"    a long note kept with its item",
	"  - [ ] 7a. a nested follow-up",
	"- [ ] 70. Ship it",
	"",
	"Prose after the list.",
	"",
	"## Notes",
	"",
	"Some notes.",
	"",
].join("\n");

describe("naming an item by its number", () => {
	it("finds the item it numbers, not one whose number starts the same", () => {
		const result = setCheckbox(NUMBERED, "70", true);
		if (!result.ok) throw new Error(result.reason);
		expect(result.line).toBe("- [x] 70. Ship it");
		const seven = setCheckbox(NUMBERED, "7", false);
		if (!seven.ok) throw new Error(seven.reason);
		expect(seven.line).toBe("- [ ] 7. **Write the tests**");
	});

	it("finds a numbered item by the words after its number", () => {
		// Sessions named plan items by their words, as "Window titles" for
		// "1. Window titles ...", and were refused for the number in front.
		const result = setCheckbox(NUMBERED, "ship it", true);
		if (!result.ok) throw new Error(result.reason);
		expect(result.line).toBe("- [x] 70. Ship it");
		const prefix = setCheckbox(NUMBERED, "Write the", false);
		if (!prefix.ok) throw new Error(prefix.reason);
		expect(prefix.line).toBe("- [ ] 7. **Write the tests**");
	});

	it("still refuses words that fit several numbered items", () => {
		const body = "- [ ] 1. Ship the gate\n- [ ] 2. Ship the timer\n";
		const result = setCheckbox(body, "Ship the", true);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.reason).toContain('2 items fit "Ship the"');
	});

	it("refuses a number no item carries, rather than matching a time", () => {
		const body = "- [ ] 1. Ship it\n- [ ] 12:00 run failed\n";
		const result = setCheckbox(body, "12", true);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.reason).toContain('No item reads "12"');
	});
});

describe("naming an item in a plan whose items are not written yet", () => {
	const DRAFTED =
		"## Work\n\n- [ ] _first checklist item_\n\n## Open Questions\n";

	it("says the only item is the template's, and where to write them", () => {
		const result = setCheckbox(DRAFTED, "2", true);
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("expected a refusal");
		expect(result.reason).toContain('No item reads "2"');
		expect(result.reason).toContain("template's placeholder");
		expect(result.reason).toContain("`section`");
	});

	it("reads the same for show as for tick", () => {
		const result = itemOf(DRAFTED, "Write the tests");
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("expected a refusal");
		expect(result.reason).toContain("template's placeholder");
	});

	it("lists the items as before once one is written", () => {
		const result = setCheckbox(`${DRAFTED}- [ ] 1. Real work\n`, "2", true);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.reason).not.toContain("template's placeholder");
	});
});

describe("naming an item by its position, in a document that numbers none", () => {
	const LISTED = [
		"- [x] Gate the tree",
		"- [ ] Count the refusals",
		"  - [ ] a nested step",
		"- [ ] 12:00 run failed",
		"",
	].join("\n");

	it("counts ticked and open items alike, nested ones included", () => {
		const second = setCheckbox(LISTED, "2", true);
		if (!second.ok) throw new Error(second.reason);
		expect(second.line).toBe("- [x] Count the refusals");
		const fourth = setCheckbox(LISTED, "4", true);
		if (!fourth.ok) throw new Error(fourth.reason);
		expect(fourth.line).toBe("- [x] 12:00 run failed");
	});

	it("keeps a number on its item as items above it are ticked", () => {
		const ticked = setCheckbox(LISTED, "2", true);
		if (!ticked.ok) throw new Error(ticked.reason);
		const nested = setCheckbox(ticked.body, "3", true);
		if (!nested.ok) throw new Error(nested.reason);
		expect(nested.line).toBe("  - [x] a nested step");
	});

	it("refuses a position past the last item, listing the positions", () => {
		const result = setCheckbox(LISTED, "5", true);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.reason).toContain("- 2. Count the refusals");
		expect(result.reason).toContain("- 4. 12:00 run failed");
	});

	it("reads the item at a position with its notes", () => {
		const result = itemOf(LISTED, "2");
		if (!result.ok) throw new Error(result.reason);
		expect(result.found).toBe("- [ ] Count the refusals");
		expect(result.text).toBe("  - [ ] a nested step");
	});

	it("gives the outline those positions, and none in a numbered plan", () => {
		expect(outlineOf(LISTED).items.map((i) => i.position)).toEqual([
			1, 2, 3, 4,
		]);
		const numbered = outlineOf("- [ ] 1. Ship it\n- [ ] Unnumbered\n");
		expect(numbered.items.map((i) => i.position)).toEqual([
			undefined,
			undefined,
		]);
	});
});

describe("naming an item by words inside it", () => {
	const BODY = [
		"- [ ] **Item 8:** frictions that stop sessions getting things done",
		"- [ ] Weekly card of what moved, by measurement",
		"- [ ] Fix the sessions getting things wrong",
		"",
	].join("\n");

	it("finds the one item holding two or more words", () => {
		const result = setCheckbox(BODY, "stop sessions", true);
		if (!result.ok) throw new Error(result.reason);
		expect(result.line).toContain("frictions that stop sessions");
	});

	it("finds the one item holding a single word of ten characters", () => {
		const result = setCheckbox(BODY, "MEASUREMENT ", true);
		if (!result.ok) throw new Error(result.reason);
		expect(result.line).toContain("by measurement");
	});

	it("won't name an item by a short word found inside it", () => {
		const result = setCheckbox(BODY, "card", true);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.reason).toContain('No item reads "card"');
	});

	it("refuses words found inside several items, naming them", () => {
		const result = setCheckbox(BODY, "sessions ", true);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.reason).toContain("No item reads");
		const both = setCheckbox(BODY, "sessions getting", true);
		if (both.ok) throw new Error("expected a refusal");
		expect(both.reason).toContain('2 items fit "sessions getting"');
	});

	it("names at most twenty candidates in a refusal", () => {
		const body = Array.from({ length: 30 }, (_, n) => `- [ ] Step ${n}`).join(
			"\n",
		);
		const result = setCheckbox(body, "nothing like it", true);
		if (result.ok) throw new Error("expected a refusal");
		expect(result.reason).toContain("- 20. Step 19\n- and 10 more");
		expect(result.reason).not.toContain("Step 20");
	});

	it("names the open items first when it can't name them all", () => {
		const body = Array.from(
			{ length: 30 },
			(_, n) => `- [${n < 25 ? "x" : " "}] ${n + 1}. Step ${n + 1}`,
		).join("\n");
		const result = setCheckbox(body, "nothing like it", true);
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("expected a refusal");
		const listed = result.reason.split("\n").slice(1);
		expect(listed.slice(0, 5)).toEqual([
			"- 26. Step 26",
			"- 27. Step 27",
			"- 28. Step 28",
			"- 29. Step 29",
			"- 30. Step 30",
		]);
		expect(result.reason).toContain("- and 10 more, all done;");
	});
});

describe("naming a number no item carries, in a document that numbers them", () => {
	it("says how far its numbers go", () => {
		const body = "- [x] 1. Ship it\n- [ ] 2. Watch it\n- [ ] 3. Measure it\n";
		const result = setCheckbox(body, "9", true);
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("expected a refusal");
		expect(result.reason).toContain(
			'No item reads "9": its items are numbered up to 3.',
		);
	});
});

describe("reading a document without all of it", () => {
	it("outlines its sections by size and its items with their depth", () => {
		const outline = outlineOf(NUMBERED);
		expect(outline.sections.map((one) => one.heading)).toEqual([
			"Work",
			"Notes",
		]);
		expect(outline.sections[1].bytes).toBe(
			Buffer.byteLength("## Notes\n\nSome notes.\n"),
		);
		const wrapped = outlineOf(
			"- [ ] Battery: idle watts at\n  fixed brightness\n  - [ ] nested\n",
		);
		expect(wrapped.items.map((one) => one.text)).toEqual([
			"Battery: idle watts at fixed brightness",
			"nested",
		]);
		expect(outline.items).toEqual([
			{ text: "7. **Write the tests**", done: true, depth: 0 },
			{ text: "7a. a nested follow-up", done: false, depth: 1 },
			{ text: "70. Ship it", done: false, depth: 0 },
		]);
	});

	it("reads one section, matched as a replacement matches it", () => {
		const found = sectionOf(PLAN, "purpose");
		if (!found.ok) throw new Error(found.reason);
		expect(found).toEqual({
			ok: true,
			found: "🎯 Purpose",
			text: "Old purpose.",
		});
		const missing = sectionOf(PLAN, "Outcomes");
		if (missing.ok) throw new Error("expected a refusal");
		expect(missing.reason).toContain("Work, 🎯 Purpose, 📜 Journey");
	});

	it("reads a deeper heading when no section bears the name, up to the next at its level", () => {
		const research = [
			"## Findings",
			"",
			"### Each Kind of Session",
			"",
			"Kinds.",
			"",
			"#### A Detail",
			"",
			"Detail.",
			"",
			"### A Mixed Fleet",
			"",
			"Fleet.",
			"",
			"## Verdict",
			"",
			"Yes.",
		].join("\n");

		const found = subsectionOf(research, "each kind of session");
		if (!found.ok) throw new Error(found.reason);
		expect(found).toEqual({
			ok: true,
			found: "Each Kind of Session",
			text: "Kinds.\n\n#### A Detail\n\nDetail.",
		});
		const last = subsectionOf(research, "A Mixed Fleet");
		expect(last).toMatchObject({ ok: true, text: "Fleet." });
		const section = subsectionOf(research, "Verdict");
		expect(section).toMatchObject({ ok: true, found: "Verdict", text: "Yes." });
		const missing = subsectionOf(research, "Nowhere");
		expect(missing).toMatchObject({ ok: false });
		if (missing.ok) throw new Error("expected a refusal");
		expect(missing.reason).toContain("Findings, Verdict");
	});

	it("reads one item with the notes nested under it, and no further", () => {
		const found = itemOf(NUMBERED, "7");
		if (!found.ok) throw new Error(found.reason);
		expect(found.found).toBe("- [x] 7. **Write the tests**");
		expect(found.text).toBe(
			[
				"  - Landed as #12, with:",
				"",
				"    a long note kept with its item",
				"  - [ ] 7a. a nested follow-up",
			].join("\n"),
		);
		const last = itemOf(NUMBERED, "70. ship");
		if (!last.ok) throw new Error(last.reason);
		expect(last.text).toBe("");
	});
});

describe("the lines holding some words", () => {
	it("finds them without case, with the section each sits under", () => {
		expect(linesHolding(PLAN, "old PURPOSE")).toEqual([
			{ line: 16, section: "🎯 Purpose", text: "Old purpose." },
		]);
	});

	it("takes either of two spelled as grep spells them", () => {
		for (const query of ["prune|recording", "prune\\|recording"]) {
			expect(
				linesHolding(PLAN, query).map((one) => one.line),
				query,
			).toEqual([5, 6]);
		}
	});

	it("reads a pipe with nothing beside it as itself", () => {
		const table = "## Codes\n\n| H17 | held |\n| H18 | let go |\n";
		expect(linesHolding(table, "| H17 |")).toEqual([
			{ line: 3, section: "Codes", text: "| H17 | held |" },
		]);
	});

	it("finds lines above the first section with none named", () => {
		expect(linesHolding(PLAN, "the plan")).toEqual([
			{ line: 1, text: "# The Plan" },
		]);
	});

	it("finds nothing for words no line holds, or for none at all", () => {
		expect(linesHolding(PLAN, "nowhere")).toEqual([]);
		expect(linesHolding(PLAN, "  ")).toEqual([]);
	});
});
