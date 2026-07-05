import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	computeBaseline,
	loadRecords,
	type QuestRecord,
} from "../../scripts/quest-store-baseline";

function quest(overrides: Partial<QuestRecord>): QuestRecord {
	return {
		id: "QEST-20260101-AAAAAA",
		status: "active",
		priority: "active",
		rank: 1,
		aliases: [],
		documents: [],
		...overrides,
	};
}

describe("computeBaseline", () => {
	it("flags a live priority left on a sealed quest", () => {
		const base = computeBaseline([
			quest({ id: "A", status: "concluded", priority: "driving" }),
			quest({ id: "B", status: "concluded", priority: "someday" }),
			quest({ id: "C", status: "active", priority: "driving" }),
		]);

		expect(base.livePriorityOnSealed).toBe(1);
	});

	it("counts every quest sharing a rank within a parent group", () => {
		const base = computeBaseline([
			quest({ id: "A", rank: 0 }),
			quest({ id: "B", rank: 0 }),
			quest({ id: "C", rank: 0, parent: "P" }),
			quest({ id: "D", rank: 5 }),
		]);

		// A and B collide at (root, 0); C is alone under P; D is alone.
		expect(base.rankCollisions).toBe(2);
		expect(base.rankZero).toBe(3);
	});

	it("treats an out-of-vocabulary status as drift", () => {
		const base = computeBaseline([
			quest({ id: "A", status: "parked" }),
			quest({ id: "B", status: undefined }),
			quest({ id: "C", status: "active" }),
		]);

		expect(base.outOfVocabStatus).toBe(2);
	});

	it("counts live children stranded under a sealed parent", () => {
		const base = computeBaseline([
			quest({ id: "P", status: "concluded" }),
			quest({ id: "C1", status: "active", parent: "P" }),
			quest({ id: "C2", status: "concluded", parent: "P" }),
		]);

		expect(base.childrenUnderSealedParent).toBe(2);
		expect(base.liveChildrenUnderSealedParent).toBe(1);
	});

	it("flags documents left unsealed under a sealed quest", () => {
		const base = computeBaseline([
			quest({
				id: "A",
				status: "concluded",
				documents: [
					{ id: "PLAN-1", stage: "build" },
					{ id: "RSCH-1", stage: "concluded" },
				],
			}),
		]);

		expect(base.documents).toBe(2);
		expect(base.unsealedDocsUnderSealedQuest).toBe(1);
	});

	it("counts alias keys shared across more than one quest", () => {
		const base = computeBaseline([
			quest({ id: "A", aliases: [{ type: "github-pr", value: "x#1" }] }),
			quest({ id: "B", aliases: [{ type: "github-pr", value: "x#1" }] }),
			quest({ id: "C", aliases: [{ type: "slack-message", value: "t1" }] }),
		]);

		expect(base.collidingAliasKeys).toBe(1);
		expect(base.slackMessageAliases).toBe(1);
		expect(base.aliasTotal).toBe(3);
	});
});

describe("loadRecords", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "quest-baseline-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("reads quest and document front-matter from disk", () => {
		const dir = join(root, "QEST-20260101-AAAAAA");
		mkdirSync(join(dir, "plans"), { recursive: true });
		writeFileSync(
			join(dir, "README.md"),
			[
				"---",
				"id: QEST-20260101-AAAAAA",
				"status: concluded",
				"priority: driving",
				"rank: 0",
				"aliases:",
				"  - github-pr:shop/world#1",
				"---",
				"# A quest",
			].join("\n"),
		);
		writeFileSync(
			join(dir, "plans", "PLAN-20260101-BBBBBB.md"),
			["---", "stage: build", "---", "# A plan"].join("\n"),
		);

		const records = loadRecords(root);

		expect(records).toHaveLength(1);
		const record = records[0];
		expect(record.status).toBe("concluded");
		expect(record.priority).toBe("driving");
		expect(record.aliases).toEqual([
			{ type: "github-pr", value: "shop/world#1" },
		]);
		expect(record.documents).toEqual([
			{ id: "PLAN-20260101-BBBBBB", stage: "build" },
		]);
	});
});
