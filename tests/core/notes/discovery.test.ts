import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverNotes } from "../../../lib/core/internal/notes/discovery.ts";
import { serializeNote } from "../../../lib/core/internal/notes/frontmatter.ts";
import type { NoteFrontMatter } from "../../../lib/core/notes/types.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "notes-discovery-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeNote(root: string, fm: NoteFrontMatter, body = "# body\n"): void {
	const noteDir = join(root, fm.id);
	mkdirSync(noteDir, { recursive: true });
	writeFileSync(join(noteDir, "README.md"), serializeNote(fm, body));
}

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

describe("discoverNotes", () => {
	it("finds nothing in an empty root", () => {
		const { index, errors } = discoverNotes(dir);
		expect(index.notes.size).toBe(0);
		expect(errors).toHaveLength(0);
	});

	it("finds a note and skips non-id directories", () => {
		writeNote(dir, fm({ id: "NOTE-20130101-AAAAAA" }));
		mkdirSync(join(dir, ".git"));
		mkdirSync(join(dir, "scratch"));
		const { index, errors } = discoverNotes(dir);
		expect([...index.notes.keys()]).toEqual(["NOTE-20130101-AAAAAA"]);
		expect(errors).toHaveLength(0);
	});

	it("reports a note whose directory has no README.md", () => {
		mkdirSync(join(dir, "NOTE-20130101-AAAAAA"));
		const { errors } = discoverNotes(dir);
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toMatch(/README\.md/);
	});

	it("reports a note whose front matter fails to parse", () => {
		mkdirSync(join(dir, "NOTE-20130101-AAAAAA"));
		writeFileSync(
			join(dir, "NOTE-20130101-AAAAAA", "README.md"),
			"not a valid note",
		);
		const { errors } = discoverNotes(dir);
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toMatch(/front matter/);
	});

	it("reports a note whose front-matter id doesn't match its directory", () => {
		mkdirSync(join(dir, "NOTE-20130101-AAAAAA"));
		writeFileSync(
			join(dir, "NOTE-20130101-AAAAAA", "README.md"),
			serializeNote(fm({ id: "NOTE-20130101-WRONGX" }), "# body\n"),
		);
		const { errors } = discoverNotes(dir);
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toMatch(/does not match/);
	});

	it("groups children by parent, with root notes under the empty key", () => {
		writeNote(dir, fm({ id: "NOTE-20130101-PARENT" }));
		writeNote(
			dir,
			fm({ id: "NOTE-20130102-CHILD1", parent: "NOTE-20130101-PARENT" }),
		);
		writeNote(
			dir,
			fm({ id: "NOTE-20130103-CHILD2", parent: "NOTE-20130101-PARENT" }),
		);
		writeNote(dir, fm({ id: "NOTE-20130104-ORPHAN" }));

		const { index } = discoverNotes(dir);
		expect(index.children.get("")).toEqual([
			"NOTE-20130101-PARENT",
			"NOTE-20130104-ORPHAN",
		]);
		expect(index.children.get("NOTE-20130101-PARENT")).toEqual([
			"NOTE-20130102-CHILD1",
			"NOTE-20130103-CHILD2",
		]);
	});
});
