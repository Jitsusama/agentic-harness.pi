/**
 * The work broker's records, read for the trees each session holds.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTreeMemory } from "../../../lib/core/work/memory.ts";
import {
	recordedTrees,
	treesHeldBy,
} from "../../../lib/internal/work-records.ts";

/** A record of a tree at `path`, held by `sessions`, its folder made. */
function recorded(dir: string, path: string, sessions?: string[]): void {
	mkdirSync(path, { recursive: true });
	createTreeMemory(dir).remember({
		identity: { key: path.replaceAll("/", "-"), shareable: false },
		path,
		providerId: "git",
		...(sessions ? { sessions } : {}),
	});
}

describe("the work broker's records", () => {
	it("say which trees a session holds, and who holds each", () => {
		const root = mkdtempSync(join(tmpdir(), "records-"));
		const dir = join(root, "cut");
		recorded(dir, join(root, "trees", "one"), ["s-1", "s-2"]);
		recorded(dir, join(root, "trees", "two"), ["s-2"]);
		recorded(dir, join(root, "trees", "old"));

		expect(treesHeldBy("s-1", dir)).toEqual([join(root, "trees", "one")]);
		expect(treesHeldBy("s-2", dir).sort()).toEqual([
			join(root, "trees", "one"),
			join(root, "trees", "two"),
		]);
		expect(
			recordedTrees(dir).find((tree) => tree.path.endsWith("old")),
			"a record naming no session holds it for nobody",
		).toEqual({ path: join(root, "trees", "old"), sessions: [] });
	});
});
