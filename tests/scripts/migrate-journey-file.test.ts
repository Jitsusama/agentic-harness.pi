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
import { JOURNEY_FILE } from "../../lib/internal/quest/journey";
import {
	migrateQuest,
	planQuest,
	questDirs,
} from "../../scripts/migrate-journey-file";

const A = "QEST-20260101-AAAAAA";
const B = "QEST-20260102-BBBBBB";
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "migrate-journey-"));
	const readme = (id: string, journey: string[]) =>
		[
			"---",
			`id: ${id}`,
			"kind: quest",
			"status: active",
			"priority: active",
			"started: 2026-01-01",
			"updated: 2026-01-01",
			"---",
			"",
			"# A Quest",
			"",
			"## 🌄 Journey",
			"",
			...journey,
			"",
		].join("\n");
	mkdirSync(join(root, A, "attachments", "runs"), { recursive: true });
	writeFileSync(join(root, A, "attachments", "runs", "one.md"), "one\n");
	writeFileSync(
		join(root, A, "README.md"),
		readme(A, [
			"- **2026-01-03**: Ran it; see attachments/runs/one.md.",
			"  It held.",
			"- **2026-01-02 (night)**: An odd date the parser skips.",
			"- **2026-01-01**: Created.",
		]),
	);
	mkdirSync(join(root, A, B), { recursive: true });
	writeFileSync(
		join(root, A, B, "README.md"),
		readme(B, ["- **2026-01-02**: Created."]),
	);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("migrate-journey-file", () => {
	it("finds quests and their subquests", () => {
		expect(questDirs(root)).toEqual([join(root, A), join(root, A, B)]);
	});

	it("plans what it moves without writing", () => {
		const plan = planQuest(join(root, A));
		expect(plan.movedLines).toBe(4);
		expect(readFileSync(join(root, A, "README.md"), "utf8")).toContain(
			"It held.",
		);
	});

	it("moves every line, keeps every entry and citation, and finds nothing more to do", () => {
		const outcome = migrateQuest(join(root, A));
		expect(outcome.problems).toEqual([]);
		expect(outcome.entries).toBe(2);
		expect(readFileSync(join(root, A, JOURNEY_FILE), "utf8")).toContain(
			"- **2026-01-02 (night)**: An odd date the parser skips.",
		);
		// No problem means nothing went uncited: the record reads what
		// JOURNEY.md cites, so the README carries no citations line.
		expect(readFileSync(join(root, A, "README.md"), "utf8")).not.toContain(
			"Cited from the Journey",
		);
		expect(migrateQuest(join(root, A)).problems).toEqual([]);
		expect(planQuest(join(root, A)).movedLines).toBe(0);
	});
});
