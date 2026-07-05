import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	aliasKey,
	buildAliasIndex,
	lookupAlias,
	lookupAliasDetail,
} from "../../../lib/internal/quest/alias-index";
import { discoverQuests } from "../../../lib/internal/quest/discovery";
import { scaffoldQuestReadme } from "../../../lib/internal/quest/scaffold";
import type { QuestAlias, QuestFrontMatter } from "../../../lib/quest/types";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "quest-alias-index-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("aliasKey", () => {
	it("is canonical in the type: case does not change the key", () => {
		expect(aliasKey({ type: "GitHub-PR", value: "shop/world#1" })).toBe(
			aliasKey({ type: "github-pr", value: "shop/world#1" }),
		);
	});

	it("keeps the value verbatim (paths and refs are case-sensitive)", () => {
		expect(aliasKey({ type: "git-worktree", value: "/A/b" })).not.toBe(
			aliasKey({ type: "git-worktree", value: "/a/b" }),
		);
	});
});

function writeQuest(id: string, aliases: QuestAlias[]): void {
	const dir = join(root, id);
	mkdirSync(dir, { recursive: true });
	const fm: QuestFrontMatter = {
		id,
		kind: "quest",
		parent: null,
		status: "active",
		priority: "active",
		rank: 1,
		started: "2026-06-03",
		updated: "2026-06-03",
		aliases,
		sessions: [],
	};
	writeFileSync(
		join(dir, "README.md"),
		`${scaffoldQuestReadme({ frontMatter: fm, title: id })}\n`,
	);
}

describe("buildAliasIndex", () => {
	it("returns a unique hit when the alias is on exactly one quest", () => {
		writeQuest("QEST-20260603-AAA111", [
			{ type: "github-pr", value: "shop/world#1" },
		]);
		const { index } = discoverQuests(root);
		const aliasIdx = buildAliasIndex(index);
		expect(
			lookupAlias(aliasIdx, { type: "github-pr", value: "shop/world#1" }),
		).toBe("QEST-20260603-AAA111");
		expect(
			lookupAliasDetail(aliasIdx, {
				type: "github-pr",
				value: "shop/world#1",
			}),
		).toEqual({ kind: "hit", questId: "QEST-20260603-AAA111" });
	});

	it("surfaces collisions rather than silently picking one quest", () => {
		writeQuest("QEST-20260603-AAA111", [
			{ type: "github-pr", value: "shop/world#1" },
		]);
		writeQuest("QEST-20260603-BBB222", [
			{ type: "github-pr", value: "shop/world#1" },
		]);
		const { index } = discoverQuests(root);
		const aliasIdx = buildAliasIndex(index);
		const detail = lookupAliasDetail(aliasIdx, {
			type: "github-pr",
			value: "shop/world#1",
		});
		expect(detail.kind).toBe("collision");
		if (detail.kind === "collision") {
			expect(detail.questIds.sort()).toEqual([
				"QEST-20260603-AAA111",
				"QEST-20260603-BBB222",
			]);
		}
		// The simpler lookup returns undefined on collision so
		// callers that ignore the detail API cannot silently
		// route to the first-write-wins quest.
		expect(
			lookupAlias(aliasIdx, { type: "github-pr", value: "shop/world#1" }),
		).toBeUndefined();
	});

	it("returns miss for an alias that no quest carries", () => {
		writeQuest("QEST-20260603-AAA111", [
			{ type: "github-pr", value: "shop/world#1" },
		]);
		const { index } = discoverQuests(root);
		const aliasIdx = buildAliasIndex(index);
		expect(
			lookupAliasDetail(aliasIdx, {
				type: "github-pr",
				value: "shop/world#999",
			}),
		).toEqual({ kind: "miss" });
	});
});
