import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearDiscoveryCache,
	discoverQuests,
	type QuestIndex,
} from "../../../../lib/internal/quest/discovery";
import { planReparent } from "../../../../lib/internal/quest/structural";

let root: string;

function writeQuest(id: string, parent: string | null): void {
	const dir = join(root, id);
	mkdirSync(dir, { recursive: true });
	const fm = [
		"---",
		`id: ${id}`,
		"kind: quest",
		`parent: ${parent ?? "null"}`,
		"status: active",
		"priority: active",
		"rank: 1",
		"started: 2026-06-04",
		"updated: 2026-06-04",
		"aliases: []",
		"sessions: []",
		"---",
		"",
		`# ${id}`,
		"",
	].join("\n");
	writeFileSync(join(dir, "README.md"), fm);
}

function index(): QuestIndex {
	return discoverQuests(root).index;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "structural-"));
	clearDiscoveryCache();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	clearDiscoveryCache();
});

describe("planReparent", () => {
	it("plans a single move and records the old and new parent", () => {
		writeQuest("QEST-20260604-AAA111", null);
		writeQuest("QEST-20260604-BBB222", null);
		const plan = planReparent(
			index(),
			["QEST-20260604-BBB222"],
			"QEST-20260604-AAA111",
		);
		expect(plan.errors).toEqual([]);
		expect(plan.changes).toEqual([
			{
				id: "QEST-20260604-BBB222",
				oldParent: null,
				newParent: "QEST-20260604-AAA111",
			},
		]);
	});

	it("skips a no-op move without erroring", () => {
		writeQuest("QEST-20260604-AAA111", null);
		writeQuest("QEST-20260604-BBB222", "QEST-20260604-AAA111");
		const plan = planReparent(
			index(),
			["QEST-20260604-BBB222"],
			"QEST-20260604-AAA111",
		);
		expect(plan.errors).toEqual([]);
		expect(plan.changes).toEqual([]);
	});

	it("errors on a missing target", () => {
		writeQuest("QEST-20260604-AAA111", null);
		const plan = planReparent(index(), ["QEST-20260604-GONE99"], null);
		expect(plan.changes).toEqual([]);
		expect(plan.errors.join(" ")).toMatch(/GONE99/);
	});

	it("errors when the new parent does not exist", () => {
		writeQuest("QEST-20260604-AAA111", null);
		const plan = planReparent(
			index(),
			["QEST-20260604-AAA111"],
			"QEST-20260604-NOPE00",
		);
		expect(plan.changes).toEqual([]);
		expect(plan.errors.join(" ")).toMatch(/NOPE00/);
	});

	it("errors on self-parenting", () => {
		writeQuest("QEST-20260604-AAA111", null);
		const plan = planReparent(
			index(),
			["QEST-20260604-AAA111"],
			"QEST-20260604-AAA111",
		);
		expect(plan.changes).toEqual([]);
		expect(plan.errors.join(" ")).toMatch(/cycle|own parent|itself/i);
	});

	it("errors on a move that would form a cycle", () => {
		// AAA -> BBB -> CCC chain; reparenting AAA under CCC
		// would put a quest under its own descendant.
		writeQuest("QEST-20260604-AAA111", null);
		writeQuest("QEST-20260604-BBB222", "QEST-20260604-AAA111");
		writeQuest("QEST-20260604-CCC333", "QEST-20260604-BBB222");
		const plan = planReparent(
			index(),
			["QEST-20260604-AAA111"],
			"QEST-20260604-CCC333",
		);
		expect(plan.changes).toEqual([]);
		expect(plan.errors.join(" ")).toMatch(/cycle/i);
	});

	it("plans valid moves and reports errors together for a bulk set", () => {
		writeQuest("QEST-20260604-AAA111", null);
		writeQuest("QEST-20260604-BBB222", null);
		writeQuest("QEST-20260604-CCC333", null);
		const plan = planReparent(
			index(),
			["QEST-20260604-BBB222", "QEST-20260604-GONE99", "QEST-20260604-CCC333"],
			"QEST-20260604-AAA111",
		);
		expect(plan.changes.map((c) => c.id)).toEqual([
			"QEST-20260604-BBB222",
			"QEST-20260604-CCC333",
		]);
		expect(plan.errors.join(" ")).toMatch(/GONE99/);
	});
});
