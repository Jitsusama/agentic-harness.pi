import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	formatHoldings,
	measureQuests,
} from "../../../extensions/cost-workflow/disk.ts";
import { clearDiscoveryCache } from "../../../lib/internal/quest/discovery.ts";
import {
	formatSize,
	type Holdings,
} from "../../../lib/internal/quest/footprint.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cost-disk-"));
	clearDiscoveryCache();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function quest(id: string, status: string, trees: string[] = []): void {
	const dir = join(root, "quests", id);
	mkdirSync(dir, { recursive: true });
	const listed =
		trees.length === 0
			? []
			: [
					"trees:",
					...trees.flatMap((path) => [
						`  - path: ${path}`,
						"    providerId: git-worktree",
						"    origin: scaffolded",
					]),
				];
	writeFileSync(
		join(dir, "README.md"),
		[
			"---",
			`id: ${id}`,
			"kind: quest",
			"parent: null",
			`status: ${status}`,
			"priority: active",
			"rank: 1",
			"started: 2026-10-01",
			"updated: 2026-10-01",
			"aliases: []",
			"sessions: []",
			...listed,
			"---",
			"",
			`# Quest ${id}`,
			"",
		].join("\n"),
	);
}

describe("the disk report", () => {
	it("reads each quest's status, title and trees from its README", async () => {
		const made = join(root, "trees", "b");
		mkdirSync(made, { recursive: true });
		mkdirSync(join(root, "workspaces", "QEST-20261001-AAAAAA"), {
			recursive: true,
		});
		quest("QEST-20261001-AAAAAA", "concluded");
		quest("QEST-20261001-BBBBBB", "active", [made]);
		const holdings = await measureQuests(
			join(root, "quests"),
			join(root, "workspaces"),
			async (path) =>
				existsSync(path) ? { bytes: 2e9, complete: true } : undefined,
		);
		const text = formatHoldings(holdings, 12);
		expect(text).toContain(
			"Quests hold 4.0 GB of their own on disk, and 2.0 GB of it could go now",
		);
		expect(text).toContain(
			"- QEST-20261001-AAAAAA Quest QEST-20261001-AAAAAA [concluded]: 2.0 GB, all of it could go (workspace 2.0 GB)",
		);
		expect(text).toContain(
			`[active]: 2.0 GB, still in use (a tree it made, 2.0 GB, at ${made})`,
		);
	});

	it("names the trees a finished quest left behind apart from what could go", async () => {
		const left = join(root, "trees", "a");
		mkdirSync(left, { recursive: true });
		mkdirSync(join(root, "workspaces", "QEST-20261001-AAAAAA"), {
			recursive: true,
		});
		quest("QEST-20261001-AAAAAA", "concluded", [left]);
		const holdings = await measureQuests(
			join(root, "quests"),
			join(root, "workspaces"),
			async (path) =>
				existsSync(path) ? { bytes: 3e9, complete: true } : undefined,
		);
		const text = formatHoldings(holdings, 12);
		expect(text).toContain("and 3.0 GB of it could go now");
		expect(text).toContain("Finished quests also left 3.0 GB in trees");
		expect(text).toContain(
			`6.0 GB, 3.0 GB could go, and a prune decides the rest (workspace 3.0 GB; a tree it left behind, 3.0 GB, at ${left})`,
		);
	});

	it("puts the heaviest first and says how many more there are", () => {
		const holding = (id: string, bytes: number) => ({
			id,
			status: "active",
			finished: false,
			workspace: { bytes, complete: true },
			made: [],
			adopted: [],
		});
		const holdings: Holdings = {
			quests: [
				holding("LIGHT", 1e6),
				holding("HEAVY", 5e9),
				holding("MID", 2e9),
			],
			adopted: [],
		};
		const lines = formatHoldings(holdings, 2).split("\n");
		const listed = lines.filter((l) => l.startsWith("- "));
		expect(listed.map((l) => l.split(" ")[1])).toEqual(["HEAVY", "MID"]);
		expect(lines).toContain("And 1 more; ask for a larger limit.");
	});

	it("says when a figure is only a lower bound", () => {
		expect(formatSize({ bytes: 3e9, complete: false })).toBe("at least 3.0 GB");
		expect(formatSize({ bytes: 0, complete: false })).toBe(
			"not measured in time",
		);
		expect(formatSize({ bytes: 4096, complete: true })).toBe("under 1 MB");
	});
});
