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
import { parseQuestFrontMatter } from "../../lib/internal/quest/frontmatter";
import { dropQuest, planQuest } from "../../scripts/drop-worktree-aliases";
import { questDirs } from "../../scripts/migrate-journey-file";

const A = "QEST-20260101-AAAAAA";
const B = "QEST-20260102-BBBBBB";
let root: string;

const readme = (id: string, lines: string[]) =>
	[
		"---",
		`id: ${id}`,
		"kind: quest",
		"status: active",
		"priority: active",
		"rank: 1",
		"started: 2026-01-01",
		"updated: 2026-01-01",
		...lines,
		"---",
		"",
		"# A Quest",
		"",
	].join("\n");

const frontMatter = (dir: string) =>
	parseQuestFrontMatter(readFileSync(join(dir, "README.md"), "utf8"))
		?.frontMatter;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "drop-worktree-aliases-"));
	mkdirSync(join(root, A, B), { recursive: true });
	writeFileSync(
		join(root, A, "README.md"),
		readme(A, [
			"aliases:",
			"  - type: git-worktree",
			"    value: /trees/one",
			"  - type: git-branch",
			"    value: one",
			"  - type: git-worktree",
			"    value: /trees/gone",
			"  - type: github-pr",
			"    value: a/b#1",
			"trees:",
			"  - path: /trees/one",
			"    providerId: git-worktree",
			"    branch: one",
		]),
	);
	writeFileSync(join(root, A, B, "README.md"), readme(B, []));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("dropping worktree aliases", () => {
	it("plans to drop only the aliases a tree's path repeats", () => {
		const plans = questDirs(root).map(planQuest);
		expect(plans.map((p) => [p.quest, p.dropped, p.kept])).toEqual([
			[A, 1, 1],
			[B, 0, 0],
		]);
		// A dry run writes nothing.
		expect(frontMatter(join(root, A))?.aliases).toHaveLength(4);
	});

	it("drops them, keeping every other alias and the updated date", () => {
		const outcome = dropQuest(join(root, A));
		expect(outcome).toMatchObject({ dropped: 1, kept: 1 });
		const fm = frontMatter(join(root, A));
		expect(fm?.aliases).toEqual([
			{ type: "git-branch", value: "one" },
			{ type: "git-worktree", value: "/trees/gone" },
			{ type: "github-pr", value: "a/b#1" },
		]);
		expect(fm?.trees?.[0]?.path).toBe("/trees/one");
		expect(fm?.updated).toBe("2026-01-01");
	});

	it("finds nothing to drop a second time", () => {
		dropQuest(join(root, A));
		const before = readFileSync(join(root, A, "README.md"), "utf8");
		expect(dropQuest(join(root, A)).dropped).toBe(0);
		expect(readFileSync(join(root, A, "README.md"), "utf8")).toBe(before);
	});
});
