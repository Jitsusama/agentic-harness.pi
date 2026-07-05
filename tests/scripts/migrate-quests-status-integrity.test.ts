import { describe, expect, it } from "vitest";
import {
	planDocumentSeals,
	planPriorityResets,
	planRankRenumber,
	type QuestEntry,
} from "../../scripts/migrate-quests-status-integrity";

function quest(overrides: Partial<QuestEntry>): QuestEntry {
	return {
		id: "QEST-20260101-AAAAAA",
		dir: "/quests/QEST-20260101-AAAAAA",
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
			{ id: "A", from: 0, to: 1 },
			{ id: "B", from: 0, to: 2 },
			{ id: "C", from: 0, to: 3 },
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
			{ id: "A", from: 5, to: 1 },
			{ id: "B", from: 9, to: 1 },
		]);
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
