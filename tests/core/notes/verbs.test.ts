import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeNote } from "../../../lib/core/internal/notes/frontmatter.ts";
import type { NoteFrontMatter } from "../../../lib/core/notes/types.ts";
import { create } from "../../../lib/core/notes/verbs/create.ts";
import {
	reparent,
	retitle,
	retype,
	tag,
} from "../../../lib/core/notes/verbs/mutate.ts";
import {
	find,
	show,
	tree,
	types,
} from "../../../lib/core/notes/verbs/queries.ts";
import { reindex } from "../../../lib/core/notes/verbs/reindex.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "notes-verbs-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function fm(
	overrides: Partial<NoteFrontMatter> & { id: string },
): NoteFrontMatter {
	return {
		type: "reference",
		title: "t",
		created: "20130101T000000Z",
		updated: "20130101T000000Z",
		tags: [],
		...overrides,
	};
}

function writeNote(
	fmOverrides: Partial<NoteFrontMatter> & { id: string },
	body?: string,
): void {
	const front = fm(fmOverrides);
	const noteDir = join(dir, front.id);
	mkdirSync(noteDir, { recursive: true });
	writeFileSync(
		join(noteDir, "README.md"),
		serializeNote(front, body ?? `# ${front.title}\n`),
	);
}

describe("create", () => {
	it("refuses without a title", () => {
		const result = create(dir, { type: "journal" });
		expect(result.ok).toBe(false);
	});

	it("refuses without a valid type", () => {
		const result = create(dir, { title: "x", type: "not-a-type" });
		expect(result.ok).toBe(false);
	});

	it("mints an id, scaffolds README.md, and returns the id as the message", () => {
		const result = create(dir, { title: "My New Note", type: "journal" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.message).toMatch(/^NOTE-\d{8}-[0-9A-Z]{6}$/);
		const text = readFileSync(join(dir, result.message, "README.md"), "utf8");
		expect(text).toContain("title: My New Note");
		expect(text).toContain("# My New Note");
	});

	it("backdates the id and created field from --created", () => {
		const result = create(dir, {
			title: "x",
			type: "journal",
			created: "20130120T000000Z",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.message.startsWith("NOTE-20130120-")).toBe(true);
	});

	it("refuses an unknown parent", () => {
		const result = create(dir, {
			title: "x",
			type: "journal",
			parent: "NOTE-nope",
		});
		expect(result.ok).toBe(false);
	});

	it("accepts a real parent and links it", () => {
		writeNote({ id: "NOTE-20130101-PAREN0" });
		const result = create(dir, {
			title: "x",
			type: "journal",
			parent: "NOTE-20130101-PAREN0",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const text = readFileSync(join(dir, result.message, "README.md"), "utf8");
		expect(text).toContain("parent: NOTE-20130101-PAREN0");
	});
});

describe("find", () => {
	it("filters by type", () => {
		writeNote({ id: "NOTE-20130101-AAAAAA", type: "journal" });
		writeNote({ id: "NOTE-20130102-BBBBBB", type: "reference" });
		const result = find(dir, { type: "journal" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.details?.count).toBe(1);
	});

	it("filters by tag", () => {
		writeNote({ id: "NOTE-20130101-AAAAAA", tags: ["Linux"] });
		writeNote({ id: "NOTE-20130102-BBBBBB", tags: ["Cooking"] });
		const result = find(dir, { tags: "Linux" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.details?.count).toBe(1);
	});

	it("filters by a case-insensitive text search over title and body", () => {
		writeNote(
			{ id: "NOTE-20130101-AAAAAA", title: "Networking basics" },
			"# Networking basics\n\nabout ROUTERS\n",
		);
		writeNote(
			{ id: "NOTE-20130102-BBBBBB", title: "A recipe" },
			"# A recipe\n\nsalt and pepper\n",
		);
		const result = find(dir, { q: "routers" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.details?.count).toBe(1);
	});

	it("filters by created date range", () => {
		writeNote({ id: "NOTE-20120101-AAAAAA", created: "20120101T000000Z" });
		writeNote({ id: "NOTE-20140101-BBBBBB", created: "20140101T000000Z" });
		const result = find(dir, { since: "20130101", until: "20150101" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.details?.count).toBe(1);
	});

	it("sorts by created ascending and honours limit", () => {
		writeNote({ id: "NOTE-20130103-CCCCCC", created: "20130103T000000Z" });
		writeNote({ id: "NOTE-20130101-AAAAAA", created: "20130101T000000Z" });
		writeNote({ id: "NOTE-20130102-BBBBBB", created: "20130102T000000Z" });
		const result = find(dir, { limit: 2 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const notes = result.details?.notes as { id: string }[];
		expect(notes.map((n) => n.id)).toEqual([
			"NOTE-20130101-AAAAAA",
			"NOTE-20130102-BBBBBB",
		]);
	});
});

describe("show", () => {
	it("returns the full note text", () => {
		writeNote({ id: "NOTE-20130101-AAAAAA", title: "Hello" });
		const result = show(dir, { id: "NOTE-20130101-AAAAAA" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.message).toContain("title: Hello");
	});

	it("resolves an unambiguous id prefix", () => {
		writeNote({ id: "NOTE-20130101-AAAAAA", title: "Hello" });
		const result = show(dir, { id: "AAAAAA" });
		expect(result.ok).toBe(true);
	});

	it("refuses an ambiguous prefix", () => {
		writeNote({ id: "NOTE-20130101-AAAAAA" });
		writeNote({ id: "NOTE-20130101-AAAABB" });
		const result = show(dir, { id: "AAAA" });
		expect(result.ok).toBe(false);
	});

	it("refuses an id that matches nothing", () => {
		const result = show(dir, { id: "NOPE" });
		expect(result.ok).toBe(false);
	});
});

describe("retype", () => {
	it("changes the type field", () => {
		writeNote({ id: "NOTE-20130101-AAAAAA", type: "inbox" });
		const result = retype(dir, { id: "NOTE-20130101-AAAAAA", type: "journal" });
		expect(result.ok).toBe(true);
		const text = readFileSync(
			join(dir, "NOTE-20130101-AAAAAA", "README.md"),
			"utf8",
		);
		expect(text).toContain("type: journal");
	});

	it("refuses an invalid type", () => {
		writeNote({ id: "NOTE-20130101-AAAAAA" });
		const result = retype(dir, { id: "NOTE-20130101-AAAAAA", type: "bogus" });
		expect(result.ok).toBe(false);
	});
});

describe("retitle", () => {
	it("updates both the title field and the body heading", () => {
		writeNote(
			{ id: "NOTE-20130101-AAAAAA", title: "Old Title" },
			"# Old Title\n\nBody paragraph.\n",
		);
		const result = retitle(dir, {
			id: "NOTE-20130101-AAAAAA",
			title: "New Title",
		});
		expect(result.ok).toBe(true);
		const text = readFileSync(
			join(dir, "NOTE-20130101-AAAAAA", "README.md"),
			"utf8",
		);
		expect(text).toContain("title: New Title");
		expect(text).toContain("# New Title");
		expect(text).not.toContain("Old Title");
	});

	it("preserves the blank line between the heading and the body", () => {
		// The specific bug this guards against: an earlier Python
		// prototype's retitle used a regex greedy enough to also
		// consume the blank line after the heading, collapsing
		// "# Title\n\nBody" into "# Title\nBody" on every retitled
		// note in one pass.
		writeNote(
			{ id: "NOTE-20130101-AAAAAA", title: "Old" },
			"# Old\n\nBody paragraph.\n",
		);
		retitle(dir, { id: "NOTE-20130101-AAAAAA", title: "New" });
		const text = readFileSync(
			join(dir, "NOTE-20130101-AAAAAA", "README.md"),
			"utf8",
		);
		expect(text).toContain("# New\n\nBody paragraph.");
	});

	it("refuses without a title", () => {
		writeNote({ id: "NOTE-20130101-AAAAAA" });
		const result = retitle(dir, { id: "NOTE-20130101-AAAAAA" });
		expect(result.ok).toBe(false);
	});
});

describe("tag", () => {
	it("adds tags without duplicating existing ones", () => {
		writeNote({ id: "NOTE-20130101-AAAAAA", tags: ["Linux"] });
		const result = tag(dir, {
			id: "NOTE-20130101-AAAAAA",
			add: "Linux, Networking",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.details?.tags).toEqual(["Linux", "Networking"]);
	});

	it("removes tags", () => {
		writeNote({ id: "NOTE-20130101-AAAAAA", tags: ["Linux", "Networking"] });
		const result = tag(dir, { id: "NOTE-20130101-AAAAAA", remove: "Linux" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.details?.tags).toEqual(["Networking"]);
	});
});

describe("reparent", () => {
	it("sets a parent", () => {
		writeNote({ id: "NOTE-20130101-PAREN0" });
		writeNote({ id: "NOTE-20130102-CHILD0" });
		const result = reparent(dir, {
			id: "NOTE-20130102-CHILD0",
			parent: "NOTE-20130101-PAREN0",
		});
		expect(result.ok).toBe(true);
		const text = readFileSync(
			join(dir, "NOTE-20130102-CHILD0", "README.md"),
			"utf8",
		);
		expect(text).toContain("parent: NOTE-20130101-PAREN0");
	});

	it("clears a parent with 'none'", () => {
		writeNote({ id: "NOTE-20130101-PAREN0" });
		writeNote({ id: "NOTE-20130102-CHILD0", parent: "NOTE-20130101-PAREN0" });
		const result = reparent(dir, {
			id: "NOTE-20130102-CHILD0",
			parent: "none",
		});
		expect(result.ok).toBe(true);
		const text = readFileSync(
			join(dir, "NOTE-20130102-CHILD0", "README.md"),
			"utf8",
		);
		expect(text).not.toContain("parent:");
	});

	it("refuses self-parenting", () => {
		writeNote({ id: "NOTE-20130101-AAAAAA" });
		const result = reparent(dir, {
			id: "NOTE-20130101-AAAAAA",
			parent: "NOTE-20130101-AAAAAA",
		});
		expect(result.ok).toBe(false);
	});

	it("refuses a reparent that would form a cycle", () => {
		writeNote({ id: "NOTE-20130101-AAAAAA" });
		writeNote({ id: "NOTE-20130102-BBBBBB", parent: "NOTE-20130101-AAAAAA" });
		// A is currently the root, B is its child. Making A a child
		// of B would close the loop A -> B -> A.
		const result = reparent(dir, {
			id: "NOTE-20130101-AAAAAA",
			parent: "NOTE-20130102-BBBBBB",
		});
		expect(result.ok).toBe(false);
	});

	it("refuses an unknown parent", () => {
		writeNote({ id: "NOTE-20130101-AAAAAA" });
		const result = reparent(dir, {
			id: "NOTE-20130101-AAAAAA",
			parent: "NOPE",
		});
		expect(result.ok).toBe(false);
	});
});

describe("tree", () => {
	it("renders the whole forest when no id is given", () => {
		writeNote({ id: "NOTE-20130101-PAREN0", title: "Parent" });
		writeNote({
			id: "NOTE-20130102-CHILD0",
			title: "Child",
			parent: "NOTE-20130101-PAREN0",
		});
		const result = tree(dir, {});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.message).toContain("NOTE-20130101-PAREN0");
		expect(result.message).toContain("  - NOTE-20130102-CHILD0");
	});

	it("renders one subtree when given an id", () => {
		writeNote({ id: "NOTE-20130101-PAREN0" });
		writeNote({ id: "NOTE-20130102-CHILD0", parent: "NOTE-20130101-PAREN0" });
		writeNote({ id: "NOTE-20130103-UNRELA0" });
		const result = tree(dir, { id: "NOTE-20130101-PAREN0" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.message).not.toContain("UNRELA0");
	});
});

describe("types", () => {
	it("counts notes per type across the full vocabulary", () => {
		writeNote({ id: "NOTE-20130101-AAAAAA", type: "journal" });
		writeNote({ id: "NOTE-20130102-BBBBBB", type: "journal" });
		writeNote({ id: "NOTE-20130103-CCCCCC", type: "reference" });
		const result = types(dir);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const counts = result.details?.counts as Record<string, number>;
		expect(counts.journal).toBe(2);
		expect(counts.reference).toBe(1);
		expect(counts.faith).toBe(0);
	});
});

describe("reindex", () => {
	it("writes an INDEX.md listing every note, sorted by created", () => {
		writeNote({
			id: "NOTE-20130102-BBBBBB",
			created: "20130102T000000Z",
			title: "Second",
		});
		writeNote({
			id: "NOTE-20130101-AAAAAA",
			created: "20130101T000000Z",
			title: "First",
		});
		const result = reindex(dir);
		expect(result.ok).toBe(true);
		const text = readFileSync(join(dir, "INDEX.md"), "utf8");
		expect(text.indexOf("First")).toBeLessThan(text.indexOf("Second"));
		expect(text).toContain("2 notes");
	});
});
