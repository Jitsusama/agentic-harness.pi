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
	applyDocMoves,
	applyFlatten,
	planDocMoves,
	planFlatten,
} from "../../scripts/migrate-quests-canonical";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "quest-migrate-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function makeQuest(dir: string, id: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "README.md"),
		`---\nid: ${id}\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-06-03\nupdated: 2026-06-03\naliases: []\nsessions: []\n---\n\n# ${id}\n`,
	);
}

describe("planFlatten", () => {
	it("returns an empty plan for an already-canonical tree", () => {
		makeQuest(join(root, "QEST-20260603-AAA111"), "QEST-20260603-AAA111");
		makeQuest(join(root, "QEST-20260603-BBB222"), "QEST-20260603-BBB222");
		const plan = planFlatten(root);
		expect(plan.nestedMoves).toEqual([]);
		expect(plan.collisions).toEqual([]);
	});

	it("plans a move for every nested QEST dir", () => {
		makeQuest(join(root, "QEST-20260603-PRT777"), "QEST-20260603-PRT777");
		makeQuest(
			join(root, "QEST-20260603-PRT777", "QEST-20260603-CHD111"),
			"QEST-20260603-CHD111",
		);
		makeQuest(
			join(root, "QEST-20260603-PRT777", "QEST-20260603-CHD222"),
			"QEST-20260603-CHD222",
		);
		const plan = planFlatten(root);
		expect(plan.nestedMoves.map((m) => m.id).sort()).toEqual([
			"QEST-20260603-CHD111",
			"QEST-20260603-CHD222",
		]);
		expect(plan.collisions).toEqual([]);
	});

	it("records a collision when a nested id already exists at the root", () => {
		makeQuest(join(root, "QEST-20260603-PRT777"), "QEST-20260603-PRT777");
		makeQuest(join(root, "QEST-20260603-CHD111"), "QEST-20260603-CHD111");
		makeQuest(
			join(root, "QEST-20260603-PRT777", "QEST-20260603-CHD111"),
			"QEST-20260603-CHD111",
		);
		const plan = planFlatten(root);
		expect(plan.nestedMoves).toEqual([]);
		expect(plan.collisions.length).toBe(1);
		expect(plan.collisions[0]).toContain("QEST-20260603-CHD111");
	});
});

describe("planDocMoves", () => {
	it("plans a move for a doc at the quest-dir root", () => {
		const questDir = join(root, "QEST-20260603-AAA111");
		makeQuest(questDir, "QEST-20260603-AAA111");
		writeFileSync(
			join(questDir, "PLAN-20260603-XXXYYY.md"),
			"---\nid: PLAN-20260603-XXXYYY\nkind: plan\n---\n# Misplaced\n",
		);
		const plan = planDocMoves(root, true);
		expect(plan.docMoves.length).toBe(1);
		expect(plan.docMoves[0].kind).toBe("plans");
		expect(plan.docMoves[0].to).toBe(
			join(questDir, "plans", "PLAN-20260603-XXXYYY.md"),
		);
	});

	it("classifies each doc kind into its subdir", () => {
		const questDir = join(root, "QEST-20260603-AAA111");
		makeQuest(questDir, "QEST-20260603-AAA111");
		writeFileSync(join(questDir, "PLAN-20260603-AAA.md"), "---\n");
		writeFileSync(join(questDir, "RSCH-20260603-BBB.md"), "---\n");
		writeFileSync(join(questDir, "BRIF-20260603-CCC.md"), "---\n");
		writeFileSync(join(questDir, "RPRT-20260603-DDD.md"), "---\n");
		const plan = planDocMoves(root, true);
		const kinds = plan.docMoves.map((m) => m.kind).sort();
		expect(kinds).toEqual(["briefs", "plans", "reports", "research"]);
	});

	it("records a collision when the target file already exists", () => {
		const questDir = join(root, "QEST-20260603-AAA111");
		makeQuest(questDir, "QEST-20260603-AAA111");
		mkdirSync(join(questDir, "plans"), { recursive: true });
		writeFileSync(join(questDir, "PLAN-20260603-XXX.md"), "---\n");
		writeFileSync(join(questDir, "plans", "PLAN-20260603-XXX.md"), "---\n");
		const plan = planDocMoves(root, true);
		expect(plan.docMoves).toEqual([]);
		expect(plan.collisions.length).toBe(1);
	});

	it("ignores non-doc files at quest-dir root", () => {
		const questDir = join(root, "QEST-20260603-AAA111");
		makeQuest(questDir, "QEST-20260603-AAA111");
		writeFileSync(join(questDir, "freeform-notes.md"), "# notes\n");
		writeFileSync(join(questDir, "scratch.txt"), "text\n");
		const plan = planDocMoves(root, true);
		expect(plan.docMoves).toEqual([]);
	});
});

describe("applyFlatten + applyDocMoves end to end", () => {
	it("flattens a nested tree and relocates a misplaced doc", () => {
		makeQuest(join(root, "QEST-20260603-PRT777"), "QEST-20260603-PRT777");
		makeQuest(
			join(root, "QEST-20260603-PRT777", "QEST-20260603-CHD111"),
			"QEST-20260603-CHD111",
		);
		writeFileSync(
			join(
				root,
				"QEST-20260603-PRT777",
				"QEST-20260603-CHD111",
				"PLAN-20260603-XXX.md",
			),
			"---\n",
		);

		const flatten = planFlatten(root);
		applyFlatten(flatten);
		const docPlan = planDocMoves(root, true);
		applyDocMoves(docPlan);

		expect(existsSync(join(root, "QEST-20260603-CHD111", "README.md"))).toBe(
			true,
		);
		expect(
			existsSync(
				join(root, "QEST-20260603-CHD111", "plans", "PLAN-20260603-XXX.md"),
			),
		).toBe(true);
		expect(
			existsSync(join(root, "QEST-20260603-PRT777", "QEST-20260603-CHD111")),
		).toBe(false);
	});

	it("re-running the planner against a canonical tree finds nothing to do", () => {
		makeQuest(join(root, "QEST-20260603-AAA111"), "QEST-20260603-AAA111");
		mkdirSync(join(root, "QEST-20260603-AAA111", "plans"), { recursive: true });
		writeFileSync(
			join(root, "QEST-20260603-AAA111", "plans", "PLAN-20260603-XXX.md"),
			"---\n",
		);
		expect(planFlatten(root).nestedMoves).toEqual([]);
		expect(planDocMoves(root, true).docMoves).toEqual([]);
	});
});
