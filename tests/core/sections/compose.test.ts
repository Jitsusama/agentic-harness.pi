import { describe, expect, it } from "vitest";
import {
	composePrBody,
	detectBodyViolations,
	PR_SECTIONS,
	PR_SHAPE,
	readPrFields,
	reviseFields,
	unwrapProse,
} from "../../../lib/core/sections/index.ts";

const FIELDS = {
	tldr: "Merging with a short commit id now works the first time.",
	problem: "Merging failed 23 times because GitHub wants the full id.",
	solution:
		"Merge expands a short id before it asks GitHub, because GitHub wants the full one.",
	validation: "A test sends a short id and checks the full one arrives.",
};

const STACK = "> [!NOTE]\n> 👈 #10 · 👇 **#11** · 👉 _next not yet created_";

describe("composePrBody", () => {
	it("writes the four sections in order, under the sanctioned headings", () => {
		const body = composePrBody(FIELDS);
		const positions = PR_SECTIONS.map((h) => body.indexOf(h));
		expect(positions.every((p) => p >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		expect(body.startsWith(PR_SECTIONS[0])).toBe(true);
	});

	it("produces a body the contract accepts", () => {
		const body = composePrBody(FIELDS, ["Part of #482", STACK]);
		expect(
			detectBodyViolations(body, { sanctioned: PR_SECTIONS, shape: PR_SHAPE }),
		).toEqual([]);
	});

	it("puts the issue line and stack note after the TL;DR's text", () => {
		const body = composePrBody(FIELDS, ["Part of #482", STACK]);
		const tldr = body.indexOf(FIELDS.tldr);
		const issue = body.indexOf("Part of #482");
		const note = body.indexOf("> [!NOTE]");
		const problem = body.indexOf(PR_SECTIONS[1]);
		expect(tldr).toBeLessThan(issue);
		expect(issue).toBeLessThan(note);
		expect(note).toBeLessThan(problem);
	});

	it("trims what each field brings with it", () => {
		const body = composePrBody({
			...FIELDS,
			problem: `\n\n${FIELDS.problem}\n\n`,
		});
		expect(body).toContain(
			`${PR_SECTIONS[1]}\n\n${FIELDS.problem}\n\n${PR_SECTIONS[2]}`,
		);
	});
});

describe("unwrapProse", () => {
	it("joins a paragraph wrapped across lines, since GitHub shows every newline", () => {
		expect(
			unwrapProse("One sentence that\nwraps here.\n\nNext paragraph."),
		).toBe("One sentence that wraps here.\n\nNext paragraph.");
	});

	it("keeps list items apart and joins an item's wrapped continuation", () => {
		expect(unwrapProse("Lead in.\n- first item\n  continues\n- second")).toBe(
			"Lead in.\n- first item continues\n- second",
		);
	});

	it("leaves code, quotes, tables and link definitions as written", () => {
		const literal =
			"```\nline one\nline two\n```\n> a note\n> more\n| a | b |\n| - | - |\n[1]: https://example.com";
		expect(unwrapProse(literal)).toBe(literal);
	});

	it("keeps a hard break the author asked for", () => {
		expect(unwrapProse("Ends with a break  \nthen this.")).toBe(
			"Ends with a break  \nthen this.",
		);
	});

	it("is applied to every section a body is composed from", () => {
		const body = composePrBody({
			...FIELDS,
			problem: "Merging failed 23\ntimes.",
		});
		expect(readPrFields(body).fields.problem).toBe("Merging failed 23 times.");
	});
});

describe("readPrFields", () => {
	it("reads back exactly what was composed", () => {
		const context = ["Part of #482", STACK];
		expect(readPrFields(composePrBody(FIELDS, context))).toEqual({
			fields: FIELDS,
			context,
		});
	});

	it("reads nothing from a body in another shape", () => {
		const old = "### 🌐 Situation\n\nOld.\n\n### 🔧 Resolution\n\nOld.";
		expect(readPrFields(old)).toEqual({ fields: {}, context: [] });
	});
});

describe("reviseFields", () => {
	it("replaces only the sections it is given", () => {
		const body = composePrBody(FIELDS, ["Part of #482"]);
		const revised = reviseFields(body, { solution: "Merge now expands it." });
		expect(readPrFields(revised)).toEqual({
			fields: { ...FIELDS, solution: "Merge now expands it." },
			context: ["Part of #482"],
		});
	});

	it("replaces the context when it is given, keeping the sections", () => {
		const body = composePrBody(FIELDS, ["Part of #482"]);
		const revised = reviseFields(body, {}, ["Part of #482", STACK]);
		expect(readPrFields(revised).context).toEqual(["Part of #482", STACK]);
		expect(readPrFields(revised).fields).toEqual(FIELDS);
	});

	it("leaves a missing section missing, for the contract to name", () => {
		const revised = reviseFields("", { tldr: FIELDS.tldr });
		const headings = detectBodyViolations(revised, {
			sanctioned: PR_SECTIONS,
		}).map((v) => v.found);
		expect(headings).toContain(PR_SECTIONS[1]);
		expect(revised).not.toContain(PR_SECTIONS[1]);
	});
});
