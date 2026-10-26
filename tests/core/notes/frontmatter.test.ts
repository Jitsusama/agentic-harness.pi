import { describe, expect, it } from "vitest";
import {
	noteFrontMatterProblem,
	parseNoteFrontMatter,
	serializeNote,
	serializeNoteFrontMatter,
	splitFrontMatter,
} from "../../../lib/core/internal/notes/frontmatter.ts";
import type { NoteFrontMatter } from "../../../lib/core/notes/types.ts";

const BASE: NoteFrontMatter = {
	id: "NOTE-20130120-3MX6UQ",
	type: "reference",
	title: "A simple title",
	created: "20130120T145200Z",
	updated: "20130120T145200Z",
	tags: [],
};

describe("splitFrontMatter", () => {
	it("splits a valid block", () => {
		const text = "---\nid: NOTE-1\n---\n\nBody text\n";
		const split = splitFrontMatter(text);
		expect(split?.fmText).toBe("id: NOTE-1");
		expect(split?.body).toBe("Body text\n");
	});

	it("returns undefined without a leading --- fence", () => {
		expect(splitFrontMatter("no fence here")).toBeUndefined();
	});

	it("returns undefined without a closing --- fence", () => {
		expect(splitFrontMatter("---\nid: x\nno closing fence")).toBeUndefined();
	});
});

describe("parseNoteFrontMatter / serializeNote round-trip", () => {
	it("round-trips a plain note", () => {
		const text = serializeNote(BASE, "# A simple title\n\nSome body text.\n");
		const parsed = parseNoteFrontMatter(text);
		expect(parsed?.frontMatter).toEqual(BASE);
		expect(parsed?.body).toContain("Some body text.");
	});

	it("round-trips a title containing a colon and quotes", () => {
		const fm: NoteFrontMatter = {
			...BASE,
			title: 'A title: with a colon and "quotes" and a \\backslash',
		};
		const text = serializeNote(fm, "# body\n");
		const parsed = parseNoteFrontMatter(text);
		expect(parsed?.frontMatter.title).toBe(fm.title);
	});

	it("does not accumulate escaping across repeated write/read cycles", () => {
		// This is the exact failure mode a hand-rolled regex-based
		// frontmatter writer hit in an earlier prototype: a title
		// with a literal quote gained an extra layer of backslash
		// on every retitle/retag pass, because the writer escaped
		// on write but the reader never unescaped on read. A real
		// YAML round-trip has no such asymmetry.
		let fm: NoteFrontMatter = { ...BASE, title: 'Say "hello"' };
		for (let i = 0; i < 5; i++) {
			const text = serializeNote(fm, "# body\n");
			const parsed = parseNoteFrontMatter(text);
			if (!parsed) throw new Error("parse failed");
			fm = parsed.frontMatter;
		}
		expect(fm.title).toBe('Say "hello"');
	});

	it("round-trips tags, parent and source", () => {
		const fm: NoteFrontMatter = {
			...BASE,
			tags: ["Networking", "Linux"],
			parent: "NOTE-20260822-AJ1W97",
			source: "web.clip",
		};
		const text = serializeNote(fm, "# body\n");
		const parsed = parseNoteFrontMatter(text);
		expect(parsed?.frontMatter).toEqual(fm);
	});

	it("defaults tags to an empty array when the field is absent", () => {
		const text =
			"---\nid: NOTE-1\ntype: journal\ntitle: t\ncreated: c\nupdated: u\n---\n\nbody\n";
		const parsed = parseNoteFrontMatter(text);
		expect(parsed?.frontMatter.tags).toEqual([]);
	});

	it("omits parent and source from serialized output when unset", () => {
		const out = serializeNoteFrontMatter(BASE);
		expect(out).not.toContain("parent:");
		expect(out).not.toContain("source:");
	});

	it("rejects an unrecognised type", () => {
		const text =
			"---\nid: NOTE-1\ntype: not-a-real-type\ntitle: t\ncreated: c\nupdated: u\n---\n\nbody\n";
		expect(parseNoteFrontMatter(text)).toBeUndefined();
	});

	it("rejects a missing required field", () => {
		const text =
			"---\nid: NOTE-1\ntype: journal\ntitle: t\ncreated: c\n---\n\nbody\n";
		expect(parseNoteFrontMatter(text)).toBeUndefined();
	});
});

describe("noteFrontMatterProblem", () => {
	it("reports no problem for a valid block", () => {
		const text = serializeNote(BASE, "# body\n");
		expect(noteFrontMatterProblem(text)).toBeUndefined();
	});

	it("names the missing fence", () => {
		expect(noteFrontMatterProblem("no fences")).toMatch(/fences/);
	});

	it("names an invalid type", () => {
		const text =
			"---\nid: NOTE-1\ntype: bogus\ntitle: t\ncreated: c\nupdated: u\n---\n\nbody\n";
		expect(noteFrontMatterProblem(text)).toMatch(/type/);
	});
});
