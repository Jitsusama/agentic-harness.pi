/**
 * What the work tool says of the trees it holds: the listing, the
 * state of the work in one, giving one back, and which tree a call
 * means.
 */

import {
	existsSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GLYPH } from "../../../extensions/work-integration/render.ts";
import { treeRecordDir } from "../../../lib/internal/work-records.ts";
import { displayPath } from "../../../lib/ui/path.ts";
import { cut, work } from "./worked.ts";

describe("listing what is held", () => {
	it("says how to get a tree when none is held", async () => {
		expect(await work({})).toEqual({
			text: `${GLYPH.named} No trees held. Ask for one with action 'tree' or 'snapshot'.`,
			details: { ok: true, held: 0 },
		});
	});

	it("lists each held tree with where it is and what cut it", async () => {
		const { key, path } = await cut();
		const listed = await work({ action: "trees" });
		expect(listed.text).toContain(`${GLYPH.tree} ${key}`);
		expect(listed.text, "where it is and what cut it").toContain(
			`${displayPath(path)} · copying`,
		);
		expect(listed.details).toMatchObject({ ok: true, held: 1 });
	});
});

/**
 * The one tree record there is, dated `hours` ago as a sweep reads it,
 * answering when it was last written.
 */
function recordAged(hours: number): () => number {
	const names = readdirSync(treeRecordDir());
	expect(names, "not one tree record, so this case tests nothing").toHaveLength(
		1,
	);
	const file = join(treeRecordDir(), names[0] ?? "");
	const then = new Date(Date.now() - hours * 3_600_000);
	utimesSync(file, then, then);
	return () => statSync(file).mtimeMs;
}

// A reader sent to a tree by path leaves no sign a sweep can see, so
// whatever hands a tree's path out dates its use, as an ask does.
describe("dating the trees it names", () => {
	it("dates each tree it lists", async () => {
		await cut();
		const written = recordAged(5);
		const before = written();

		await work({ action: "trees" });

		expect(written(), "listing a tree didn't date its use").toBeGreaterThan(
			before,
		);
	});

	it("dates the tree an action names", async () => {
		const { key } = await cut();
		const written = recordAged(5);
		const before = written();

		await work({ action: "status", tree: key });

		expect(written(), "naming a tree didn't date its use").toBeGreaterThan(
			before,
		);
	});

	// The broker's listing drops a tree whose folder went, so a take
	// before the action reads as not held; the refusal in the action is
	// for a take landing between that listing and the dating.
	it("says a tree a sweep took is no longer held", async () => {
		const { key, path } = await cut();
		rmSync(path, { recursive: true, force: true });

		const status = await work({ action: "status", tree: key });

		expect(status.text).toBe(
			`${GLYPH.refused} No held tree called ${key}: none are held.`,
		);
	});
});

describe("the work in a tree", () => {
	it("says a clean tree is clean, and the branch it is on", async () => {
		const { key } = await cut();
		expect(await work({ action: "status" })).toEqual({
			text: `${GLYPH.clean} ${key} is clean, on topic.`,
			details: { ok: true, clean: true },
		});
	});

	it("lists each changed path", async () => {
		const { key, path } = await cut();
		writeFileSync(join(path, "notes.txt"), "work\n");
		const status = await work({ action: "status", tree: key });
		expect(status.text).toContain(
			`${GLYPH.dirty} ${key} has 1 changed paths, on topic.`,
		);
		expect(status.text).toContain("notes.txt");
		expect(status.details).toEqual({ ok: true, clean: false, changed: 1 });
	});
});

describe("giving a tree back", () => {
	it("releases a clean tree and stops listing it", async () => {
		const { key, path } = await cut();
		expect(await work({ action: "release", tree: key })).toEqual({
			text: `${GLYPH.named} Released ${key}.`,
			details: { ok: true, released: key },
		});
		expect(existsSync(path), "the tree is gone from disk").toBe(false);
		expect((await work({})).details).toEqual({ ok: true, held: 0 });
	});

	it("refuses to release a tree holding uncommitted work, keeping it", async () => {
		const { key, path } = await cut();
		writeFileSync(join(path, "notes.txt"), "work\n");
		const released = await work({ action: "release", tree: key });
		expect(released.text).toBe(
			`${GLYPH.refused} This tree is holding uncommitted work (notes.txt), so re-pointing it would throw that away. Commit it, stash it, or ask for a different tree.`,
		);
		expect(released.details.ok).not.toBe(true);
		expect(existsSync(join(path, "notes.txt")), "the work is kept").toBe(true);
	});
});

describe("which tree a call means", () => {
	it("names what is held when the tree named is not", async () => {
		const { key } = await cut();
		const answer = await work({ action: "status", tree: "nope" });
		expect(answer.text).toContain(`${GLYPH.refused} No held tree called nope:`);
		expect(answer.text).toContain(key);
	});

	it("asks which when several are held and none is named", async () => {
		const first = await cut("first");
		const second = await cut("second");
		const answer = await work({ action: "status" });
		expect(answer.text).toBe(
			`${GLYPH.refused} Say which tree, by its key or its path. 2 are held: ${first.key}, ${second.key}.`,
		);
	});

	it("asks for a tree when none is held", async () => {
		expect((await work({ action: "status" })).text).toBe(
			`${GLYPH.refused} No tree is held. Ask for one with work tree, naming the repo, the branch and what it is for.`,
		);
	});
});
