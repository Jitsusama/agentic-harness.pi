/**
 * Where pi works, told as the machine's prompt tells a folder, and what
 * the machine says to tell it by.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { told } from "../../../extensions/status-line-widget/place.ts";
import {
	DEFAULT_WHERE,
	readWhere,
} from "../../../extensions/status-line-widget/where.ts";

/** A disk holding only these files. */
function holding(...files: string[]) {
	const set = new Set(files);
	return (file: string) => set.has(file);
}

describe("a folder, told from its root", () => {
	const disk = holding("/h/world/src/.git", "/h/world/src/zone/zone.nix");

	it("starts from the nearest root, whichever marker made it one", () => {
		expect(
			told("/h/world/src/zone/modules", ["zone.nix", ".git"], "/h", disk),
		).toEqual({
			lead: "",
			parts: ["zone", "modules"],
			first: "text",
		});
	});

	it("is the root's name alone at the root", () => {
		expect(
			told("/h/world/src", ["zone.nix", ".git"], "/h", disk).parts,
		).toEqual(["src"]);
	});

	it("starts from home outside any root", () => {
		expect(told("/h/notes/today", [".git"], "/h", disk)).toEqual({
			lead: "",
			parts: ["~", "notes", "today"],
			first: "text",
		});
	});

	it("starts from the top, muted, outside home", () => {
		expect(told("/etc/nixos", [".git"], "/h", disk)).toEqual({
			lead: "/",
			parts: ["etc", "nixos"],
			first: "muted",
		});
	});

	it("doesn't take a folder beside home for one inside it", () => {
		expect(told("/home2/x", [".git"], "/home", disk).lead).toBe("/");
	});
});

describe("what the machine says to tell it by", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "status-line-where-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("is the default when the machine says nothing", () => {
		expect(readWhere(join(dir, "where.json"))).toBe(DEFAULT_WHERE);
	});

	it("is the default when what it says isn't JSON", () => {
		writeFileSync(join(dir, "where.json"), "{ engine");

		expect(readWhere(join(dir, "where.json"))).toBe(DEFAULT_WHERE);
	});

	it("takes the engine, the roots and each mark it names, and the default for the rest", () => {
		writeFileSync(
			join(dir, "where.json"),
			JSON.stringify({
				engine: "/bin/git-engine",
				roots: ["zone.nix", ".git"],
				marks: { more: "~", branch: 7 },
			}),
		);
		const where = readWhere(join(dir, "where.json"));

		expect(where.engine).toBe("/bin/git-engine");
		expect(where.roots).toEqual(["zone.nix", ".git"]);
		expect(where.marks.more).toBe("~");
		expect(where.marks.branch).toBe(DEFAULT_WHERE.marks.branch);
	});

	it("leaves unread a mark the line doesn't draw, as a prompt's unsaved and unpushed are", () => {
		writeFileSync(
			join(dir, "where.json"),
			JSON.stringify({
				marks: { unsaved: "●", unpushed: "", more: "~" },
			}),
		);
		const where = readWhere(join(dir, "where.json"));

		expect(where.marks).not.toHaveProperty("unsaved");
		expect(where.marks).not.toHaveProperty("unpushed");
		expect(where.marks.more).toBe("~");
	});

	it("keeps the default roots over an empty list, which would tell nothing", () => {
		writeFileSync(join(dir, "where.json"), JSON.stringify({ roots: [] }));

		expect(readWhere(join(dir, "where.json")).roots).toEqual([".git"]);
	});
});
