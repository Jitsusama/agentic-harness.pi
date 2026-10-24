/**
 * A quest's workspace folder: a btrfs subvolume of its own where it
 * can be, so builds in it don't share a tree lock and log with the
 * files beside it, and a plain folder everywhere else.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { questTempDir } from "../../../extensions/quest-workflow/scratch.ts";
import {
	makeWorkspace,
	type WorkspaceFolders,
} from "../../../extensions/quest-workflow/workspace.ts";

const QUEST = "QEST-20261022-ABC123";
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "quest-folder-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Folders as a filesystem would make them, recording each subvolume. */
function folders(btrfs: boolean, made = true) {
	const subvolumes: string[] = [];
	const asked: string[] = [];
	const maker: WorkspaceFolders = {
		onBtrfs: (dir) => {
			asked.push(dir);
			return btrfs;
		},
		subvolume: (dir) => {
			subvolumes.push(dir);
			if (made) mkdirSync(dir);
			return made;
		},
	};
	return { maker, subvolumes, asked };
}

describe("a quest's workspace folder", () => {
	it("is a subvolume of its own where its root is on btrfs", () => {
		// 7SU7HB measured an app's save beside 20 cargo builds at p99
		// 600 ms with the builds in @home, and 18 ms with them in a
		// subvolume of their own: a subvolume has its own log to sync.
		const dir = join(root, "workspaces", QUEST);
		const { maker, subvolumes, asked } = folders(true);

		makeWorkspace(dir, maker);

		expect(subvolumes).toEqual([dir]);
		expect(asked).toEqual([join(root, "workspaces")]);
		expect(statSync(dir).isDirectory()).toBe(true);
	});

	it("is a plain folder off btrfs", () => {
		const dir = join(root, "workspaces", QUEST);
		const { maker, subvolumes } = folders(false);

		makeWorkspace(dir, maker);

		expect(subvolumes).toEqual([]);
		expect(statSync(dir).isDirectory()).toBe(true);
	});

	it("is a plain folder when a subvolume can't be made", () => {
		const dir = join(root, "workspaces", QUEST);
		const { maker, subvolumes } = folders(true, false);

		makeWorkspace(dir, maker);

		expect(subvolumes).toEqual([dir]);
		expect(statSync(dir).isDirectory()).toBe(true);
	});

	it("is left as it is once made", () => {
		// A workspace made before this holds the quest's clones and
		// builds; it is never moved, only new ones made apart.
		const dir = join(root, "workspaces", QUEST);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "kept"), "");
		const { maker, subvolumes } = folders(true);

		makeWorkspace(dir, maker);

		expect(subvolumes).toEqual([]);
		expect(existsSync(join(dir, "kept"))).toBe(true);
	});

	it("is made this way when a quest's commands first need a TMPDIR", () => {
		const workspaces = join(root, "workspaces");
		const links = join(root, "t");
		mkdirSync(links);
		const { maker, subvolumes } = folders(true);

		questTempDir(workspaces, QUEST, links, maker);

		expect(subvolumes).toEqual([join(workspaces, QUEST)]);
		expect(statSync(join(workspaces, QUEST, "tmp")).isDirectory()).toBe(true);
	});
});
