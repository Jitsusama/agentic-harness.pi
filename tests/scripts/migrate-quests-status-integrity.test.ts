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
import {
	applyDocumentSeals,
	applyPriorityResets,
	applyRankRenumber,
	planDocumentSeals,
	planMigration,
	planPriorityResets,
	planRankRenumber,
	type QuestEntry,
	scan,
} from "../../scripts/migrate-quests-status-integrity";

function quest(overrides: Partial<QuestEntry>): QuestEntry {
	const id = overrides.id ?? "QEST-20260101-AAAAAA";
	return {
		id,
		dir: `/quests/${id}`,
		status: "active",
		priority: "active",
		rank: 1,
		parent: null,
		documents: [],
		...overrides,
	};
}

describe("planPriorityResets", () => {
	it("resets a sealed quest that still carries a live priority", () => {
		const plan = planPriorityResets([
			quest({ id: "A", status: "concluded", priority: "driving" }),
			quest({ id: "B", status: "retired", priority: "active" }),
			quest({ id: "C", status: "concluded", priority: "someday" }),
			quest({ id: "D", status: "active", priority: "driving" }),
		]);

		expect(plan.map((p) => p.id)).toEqual(["A", "B"]);
		expect(plan.every((p) => p.to === "someday")).toBe(true);
	});
});

describe("planRankRenumber", () => {
	it("renumbers a colliding group to a contiguous 1..N", () => {
		const plan = planRankRenumber([
			quest({ id: "A", rank: 0 }),
			quest({ id: "B", rank: 0 }),
			quest({ id: "C", rank: 0 }),
		]);

		// All three share (root, active); ordered by id on the rank tie,
		// so A stays effectively first but moves 0 -> 1, B -> 2, C -> 3.
		expect(plan).toEqual([
			{ id: "A", dir: "/quests/A", from: 0, to: 1 },
			{ id: "B", dir: "/quests/B", from: 0, to: 2 },
			{ id: "C", dir: "/quests/C", from: 0, to: 3 },
		]);
	});

	it("leaves an already-contiguous group untouched", () => {
		const plan = planRankRenumber([
			quest({ id: "A", rank: 1 }),
			quest({ id: "B", rank: 2 }),
		]);

		expect(plan).toEqual([]);
	});

	it("keeps distinct sibling groups independent", () => {
		const plan = planRankRenumber([
			quest({ id: "A", rank: 5, priority: "driving" }),
			quest({ id: "B", rank: 9, priority: "queued" }),
		]);

		// Each is alone in its bucket, so both become rank 1.
		expect(plan).toEqual([
			{ id: "A", dir: "/quests/A", from: 5, to: 1 },
			{ id: "B", dir: "/quests/B", from: 9, to: 1 },
		]);
	});
});

describe("planMigration", () => {
	it("renumbers a reset quest within the someday group it lands in", () => {
		// X is sealed but driving at rank 2; it will reset to someday. Y is
		// already someday at rank 1. Computing ranks from the raw snapshot
		// would renumber X inside driving and leave it colliding with Y at
		// someday rank 1. planMigration simulates the reset first.
		const { priorities, ranks } = planMigration([
			quest({ id: "X", status: "concluded", priority: "driving", rank: 5 }),
			quest({ id: "Y", status: "active", priority: "someday", rank: 1 }),
		]);
		expect(priorities.map((p) => p.id)).toEqual(["X"]);
		// X lands in someday after Y (rank 5 sorts after Y's 1), so X -> 2,
		// never colliding with Y at 1. The raw-snapshot path would have
		// renumbered X to 1 inside driving and then collided at someday.
		const xRank = ranks.find((r) => r.id === "X");
		expect(xRank?.to).toBe(2);
	});
});

describe("apply path", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "quest-migrate-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function writeQuest(
		id: string,
		fm: { status: string; priority: string; rank: number },
		extras: string,
	): void {
		const dir = join(root, id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "README.md"),
			`---\nid: ${id}\nkind: quest\nparent: null\nstatus: ${fm.status}\npriority: ${fm.priority}\nrank: ${fm.rank}\nstarted: 2026-01-01\nupdated: 2026-01-01\n${extras}---\n\n# ${id}\n\nBody stays put.\n`,
		);
	}

	function runOnce(): void {
		const { priorities, ranks, docs } = planMigration(scan(root));
		applyPriorityResets(root, priorities);
		applyRankRenumber(root, ranks);
		applyDocumentSeals(docs);
	}

	it("converges in one pass and is idempotent on a second run", () => {
		writeQuest(
			"QEST-20260101-AAAAAA",
			{
				status: "concluded",
				priority: "driving",
				rank: 2,
			},
			"",
		);
		writeQuest(
			"QEST-20260101-BBBBBB",
			{
				status: "active",
				priority: "someday",
				rank: 1,
			},
			"",
		);
		runOnce();
		// A second run finds nothing left to do: the store reached its
		// fixed point in a single pass.
		const second = planMigration(scan(root));
		expect(second.priorities).toEqual([]);
		expect(second.ranks).toEqual([]);
		expect(second.docs).toEqual([]);
	});

	it("preserves unrelated front-matter fields and the body", () => {
		const id = "QEST-20260101-CCCCCC";
		writeQuest(
			id,
			{ status: "concluded", priority: "driving", rank: 3 },
			"aliases:\n  - type: github-pr\n    value: shop/world#7\n",
		);
		runOnce();
		const text = readFileSync(join(root, id, "README.md"), "utf8");
		expect(text).toContain("priority: someday");
		expect(text).toContain("value: shop/world#7");
		expect(text).toContain("Body stays put.");
	});
});

describe("planDocumentSeals", () => {
	it("seals active documents under a sealed quest to the terminal stage", () => {
		const plan = planDocumentSeals([
			quest({
				id: "A",
				status: "retired",
				documents: [
					{ path: "/A/plans/p.md", stage: "build" },
					{ path: "/A/research/r.md", stage: "concluded" },
				],
			}),
			quest({
				id: "B",
				status: "active",
				documents: [{ path: "/B/plans/p.md", stage: "draft" }],
			}),
		]);

		expect(plan).toEqual([
			{ path: "/A/plans/p.md", from: "build", to: "retired" },
		]);
	});
});
