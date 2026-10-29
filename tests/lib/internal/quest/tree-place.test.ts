/**
 * Where a quest's tree is, seen from the machine reading the quest.
 */

import { describe, expect, it } from "vitest";
import {
	placedHere,
	treePlace,
	treesHere,
	withHostsBackfilled,
} from "../../../../lib/internal/quest/tree-place";
import type { QuestTree } from "../../../../lib/quest/types";

const onOptimus = {
	host: "optimus",
	exists: (path: string) => path === "/here",
};
const tree = (path: string, host?: string): QuestTree => ({
	path,
	providerId: "git-worktree",
	...(host ? { host } : {}),
});

describe("where a tree is", () => {
	it("is here when it names this machine, whether or not its folder is", () => {
		expect(treePlace(tree("/here", "optimus"), onOptimus)).toBe("here");
		expect(treePlace(tree("/released", "optimus"), onOptimus)).toBe("here");
	});

	it("is elsewhere when it names another machine, even at a path that is here", () => {
		expect(treePlace(tree("/here", "equilibrius"), onOptimus)).toBe(
			"elsewhere",
		);
	});

	it("is here for a tree from before machines were named, when its folder is here", () => {
		expect(treePlace(tree("/here"), onOptimus)).toBe("here");
	});

	it("can't be told for a tree that names no machine and isn't here", () => {
		expect(treePlace(tree("/somewhere"), onOptimus)).toBe("unplaced");
	});
});

describe("this machine's trees", () => {
	it("are the ones here, in the order the quest lists them", () => {
		const trees = [
			tree("/here"),
			tree("/a", "equilibrius"),
			tree("/b", "optimus"),
			tree("/gone"),
		];
		expect(treesHere(trees, onOptimus).map((t) => t.path)).toEqual([
			"/here",
			"/b",
		]);
	});
});

describe("naming the machine", () => {
	it("names this one on a tree it records", () => {
		expect(placedHere(tree("/here"), onOptimus).host).toBe("optimus");
	});

	it("backfills only untagged trees whose folder is here", () => {
		const trees = [tree("/here"), tree("/gone"), tree("/a", "equilibrius")];
		expect(withHostsBackfilled(trees, onOptimus)).toEqual([
			tree("/here", "optimus"),
			tree("/gone"),
			tree("/a", "equilibrius"),
		]);
	});

	it("says nothing needed it when every tree is named or can't be placed", () => {
		const trees = [tree("/gone"), tree("/a", "equilibrius")];
		expect(withHostsBackfilled(trees, onOptimus)).toBeUndefined();
	});
});
