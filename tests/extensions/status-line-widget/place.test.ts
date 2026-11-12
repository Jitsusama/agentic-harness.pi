/**
 * Where pi works, told as the machine's prompt tells a folder, and what
 * the machine says to tell it by.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	rootName,
	told,
} from "../../../extensions/status-line-widget/place.ts";
import {
	DEFAULT_WHERE,
	engineNamed,
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

/** Files that read as these texts, and every other as missing. */
function reading(files: Record<string, string>) {
	return (file: string) => files[file] ?? null;
}

const ORIGIN = '[core]\n\tbare = false\n[remote "origin"]\n\turl = ';

describe("a root that is a broker's worktree", () => {
	const tree =
		"/h/trees/worktree-github-Jitsusama-agentic-harness.pi-feat-shell-edit-guard";
	const linked = {
		[`${tree}/.git`]: "gitdir: /h/src/harness/.git/worktrees/wt\n",
		"/h/src/harness/.git/worktrees/wt/commondir": "../..\n",
	};

	it("is named by its origin, not the folder the broker named", () => {
		const read = reading({
			...linked,
			"/h/src/harness/.git/config": `${ORIGIN}git@github.com:Jitsusama/agentic-harness.pi.git\n`,
		});

		expect(
			told(`${tree}/lib`, [".git"], "/h", holding(`${tree}/.git`), read).parts,
			"the repository and the folder below it",
		).toEqual(["agentic-harness.pi", "lib"]);
	});

	it("takes an https origin, and one from a bare repository", () => {
		const read = reading({
			[`${tree}/.git`]: "gitdir: /h/world/git/worktrees/wt",
			"/h/world/git/worktrees/wt/commondir": "../..",
			"/h/world/git/config": `${ORIGIN}https://github.com/Shopify/world/\n`,
		});

		expect(rootName(tree, read), "the origin's last part").toBe("world");
	});

	it("is named by the checkout holding it when there is no origin", () => {
		expect(rootName(tree, reading(linked)), "the main checkout's folder").toBe(
			"harness",
		);
	});

	it("keeps its own name when it is a checkout of its own", () => {
		expect(rootName("/h/src/notes", reading({})), "a plain folder's name").toBe(
			"notes",
		);
	});

	it("reads the worktree's files from the disk", () => {
		const dir = mkdtempSync(join(tmpdir(), "status-line-tree-"));
		try {
			const common = join(dir, "src", "harness", ".git");
			mkdirSync(join(common, "worktrees", "wt"), { recursive: true });
			mkdirSync(join(dir, "trees", "worktree-github-x-y-main"), {
				recursive: true,
			});
			const root = join(dir, "trees", "worktree-github-x-y-main");
			writeFileSync(join(root, ".git"), `gitdir: ${common}/worktrees/wt\n`);
			writeFileSync(join(common, "worktrees", "wt", "commondir"), "../..\n");
			writeFileSync(join(common, "config"), `${ORIGIN}git@host:x/y.git\n`);

			expect(
				told(root, [".git"], "/nowhere").parts,
				"the origin's name",
			).toEqual(["y"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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

	it("names the engine a switch wrote since, and the last one while the file doesn't read", () => {
		const file = join(dir, "where.json");
		writeFileSync(file, JSON.stringify({ engine: "/old/git-engine" }));
		const named = engineNamed("/old/git-engine", file);

		writeFileSync(file, JSON.stringify({ engine: "/new/git-engine" }));
		expect(named()).toBe("/new/git-engine");
		writeFileSync(file, "{ engi");
		expect(named()).toBe("/new/git-engine");
	});

	it("keeps the default roots over an empty list, which would tell nothing", () => {
		writeFileSync(join(dir, "where.json"), JSON.stringify({ roots: [] }));

		expect(readWhere(join(dir, "where.json")).roots).toEqual([".git"]);
	});
});
