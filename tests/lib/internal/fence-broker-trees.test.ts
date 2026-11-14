/**
 * The work broker's trees inside the fence: read-only but the trees the
 * session holds and the one it stands in, with each one's `.git` file
 * kept, so no command can point git outside at settings of its making.
 */

import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fenceArgs, fenceRefusesWrite } from "../../../lib/internal/fence.ts";
import type { BrokerTrees } from "../../../lib/internal/fence-broker-trees.ts";
import type { Disk } from "../../../lib/internal/fence-disk.ts";
import { brokerTrees } from "../../../lib/internal/sandbox-trees.ts";

const HOME = "/home/someone";
const ROOT = `${HOME}/.local/state/pi/work/trees`;
const RECORDS = `${HOME}/.local/state/pi/work/cut`;
const MINE = `${ROOT}/worktree-mine`;
const HELD = `${ROOT}/worktree-held`;
const THEIRS = `${ROOT}/worktree-theirs`;

/** A disk with the broker's folders and trees, each tree with a `.git` file. */
const DISK_WITH_TREES: Disk = {
	kind: (path) => {
		if (path.endsWith("/.git")) return "file";
		return path.startsWith(HOME) ? "folder" : undefined;
	},
	entries: (folder) => (folder === HOME ? [".local"] : []),
};

const TREES: BrokerTrees = { root: ROOT, records: RECORDS, held: [HELD] };

/** The fence's place for a command standing in `cwd`. */
function placeIn(cwd: string) {
	return { home: HOME, runtimeDir: "/run/user/1000", cwd, trees: TREES };
}

/** The paths bound with `flag`, in order. */
function boundWith(args: readonly string[], flag: string): string[] {
	return args.flatMap((arg, at) => (arg === flag ? [args[at + 1] ?? ""] : []));
}

describe("the broker's trees in the fence's arguments", () => {
	const args = fenceArgs(placeIn(join(MINE, "lib")), DISK_WITH_TREES);
	const readOnly = boundWith(args, "--ro-bind");
	const writable = boundWith(args, "--bind");

	it("keeps the trees' folder and the records of who holds them read-only", () => {
		expect(readOnly, "the trees' folder isn't read-only").toContain(ROOT);
		expect(readOnly, "the records aren't read-only").toContain(RECORDS);
	});

	it("binds back the tree the command stands in and the trees the session holds", () => {
		expect(writable, "the tree it stands in isn't writable").toContain(MINE);
		expect(writable, "a held tree isn't writable").toContain(HELD);
		expect(writable, "another session's tree is writable").not.toContain(
			THEIRS,
		);
	});

	it("keeps each writable tree's .git file read-only over it", () => {
		expect(readOnly, "its own tree's .git file is writable").toContain(
			`${MINE}/.git`,
		);
		expect(readOnly, "a held tree's .git file is writable").toContain(
			`${HELD}/.git`,
		);
		expect(
			args.lastIndexOf(`${HELD}/.git`),
			"the .git file is bound before its tree, so the tree hides it",
		).toBeGreaterThan(args.lastIndexOf(HELD));
	});

	it("binds the trees after the home folder's hidden entries, so .local doesn't undo them", () => {
		expect(
			args.lastIndexOf(ROOT),
			"the trees' folder is bound before .local, which makes it writable again",
		).toBeGreaterThan(args.lastIndexOf(`${HOME}/.local`));
	});

	it("binds nothing for trees when it's told of none", () => {
		const bare = fenceArgs(
			{ home: HOME, runtimeDir: "/run/user/1000", cwd: MINE },
			DISK_WITH_TREES,
		);
		expect(bare, "trees were bound with no broker named").not.toContain(ROOT);
	});
});

describe("pi's own file tools in the broker's trees", () => {
	const place = placeIn(MINE);
	const refuses = (path: string) =>
		fenceRefusesWrite(path, place, DISK_WITH_TREES);

	it("write in the session's own trees", () => {
		expect(refuses(`${MINE}/a.ts`), "its own tree was refused").toBe(false);
		expect(refuses(`${HELD}/a.ts`), "a held tree was refused").toBe(false);
	});

	it("don't write in another session's tree, the folder, the records or a .git file", () => {
		expect(
			refuses(`${THEIRS}/a.ts`),
			"another session's tree was written",
		).toBe(true);
		expect(
			refuses(`${ROOT}/worktree-new`),
			"a new tree was made in the folder",
		).toBe(true);
		expect(refuses(`${RECORDS}/x.json`), "a record was written").toBe(true);
		expect(refuses(`${HELD}/.git`), "a held tree's .git file was written").toBe(
			true,
		);
	});
});

describe("the trees a session holds, from the broker's records", () => {
	let scratch = "";
	afterEach(() => {
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	});

	/** A record saying `sessions` hold the tree at `path`. */
	function record(
		records: string,
		name: string,
		path: string,
		sessions: string[],
	) {
		mkdirSync(path, { recursive: true });
		writeFileSync(
			join(records, `${name}.json`),
			JSON.stringify({
				identity: { key: name },
				path,
				providerId: "git-worktree",
				sessions,
			}),
		);
	}

	it("names only the session's trees, and reads the records again once they change", () => {
		// As it really is, as the trees come back, since TMPDIR may be a link.
		scratch = realpathSync(mkdtempSync(join(tmpdir(), "broker-trees-")));
		const root = join(scratch, "trees");
		const records = join(scratch, "cut");
		mkdirSync(records, { recursive: true });
		record(records, "a", join(root, "a"), ["s1"]);
		record(records, "b", join(root, "b"), ["s2"]);
		const first = brokerTrees("s1", root, records);
		expect(first.held, "s1's trees").toEqual([join(root, "a")]);
		record(records, "c", join(root, "c"), ["s1", "s2"]);
		// A later time than the first read, as a rename into the folder sets.
		utimesSync(records, new Date(), new Date(Date.now() + 5000));
		expect(
			[...brokerTrees("s1", root, records).held].sort(),
			"a tree taken up after the first read is missing",
		).toEqual([join(root, "a"), join(root, "c")]);
	});

	it("holds nothing for a session with no name or no records", () => {
		expect(
			brokerTrees(undefined, "/nowhere", "/nowhere/cut").held,
			"held with no session",
		).toEqual([]);
		expect(
			brokerTrees("s1", "/nowhere", "/nowhere/cut").held,
			"held with no records",
		).toEqual([]);
	});
});
