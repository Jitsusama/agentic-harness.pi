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
import { mutateQuestFrontMatter } from "../../../../lib/internal/quest/mutate";

let root: string;
let questDir: string;

function writeQuest(fields: Record<string, string>): void {
	const lines = ["---"];
	for (const [key, value] of Object.entries(fields))
		lines.push(`${key}: ${value}`);
	lines.push("---", "# A quest", "", "Body stays put.");
	writeFileSync(join(questDir, "README.md"), lines.join("\n"));
}

const BASE = {
	id: "QEST-20260101-AAAAAA",
	kind: "quest",
	parent: "null",
	status: "active",
	priority: "active",
	rank: "1",
	started: "2026-01-01",
	updated: "2026-01-01",
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "quest-mutate-"));
	questDir = join(root, "QEST-20260101-AAAAAA");
	mkdirSync(questDir, { recursive: true });
	writeQuest(BASE);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("mutateQuestFrontMatter", () => {
	it("applies a valid field change and reports the diff", () => {
		const result = mutateQuestFrontMatter(questDir, (fm) => ({
			...fm,
			priority: "driving",
		}));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.fm.priority).toBe("driving");
		expect(result.changes).toContainEqual({
			id: "QEST-20260101-AAAAAA",
			field: "priority",
			old: "active",
			new: "driving",
		});
		expect(readFileSync(join(questDir, "README.md"), "utf8")).toContain(
			"priority: driving",
		);
	});

	it("refuses a transform that would produce an unreadable record", () => {
		const before = readFileSync(join(questDir, "README.md"), "utf8");
		const result = mutateQuestFrontMatter(questDir, (fm) => ({
			...fm,
			status: "parked" as QuestStatusCast,
		}));

		expect(result.ok).toBe(false);
		expect(readFileSync(join(questDir, "README.md"), "utf8")).toBe(before);
	});

	it("refuses an out-of-vocabulary priority", () => {
		const before = readFileSync(join(questDir, "README.md"), "utf8");
		const result = mutateQuestFrontMatter(questDir, (fm) => ({
			...fm,
			priority: "urgent" as QuestPriorityCast,
		}));

		expect(result.ok).toBe(false);
		expect(readFileSync(join(questDir, "README.md"), "utf8")).toBe(before);
	});

	it("refuses a non-integer rank", () => {
		const before = readFileSync(join(questDir, "README.md"), "utf8");
		const result = mutateQuestFrontMatter(questDir, (fm) => ({
			...fm,
			rank: Number.NaN,
		}));

		expect(result.ok).toBe(false);
		expect(readFileSync(join(questDir, "README.md"), "utf8")).toBe(before);
	});

	it("preserves the body and stamps updated by default", () => {
		const result = mutateQuestFrontMatter(questDir, (fm) => ({
			...fm,
			priority: "queued",
		}));

		expect(result.ok).toBe(true);
		const text = readFileSync(join(questDir, "README.md"), "utf8");
		expect(text).toContain("Body stays put.");
		expect(text).not.toContain("updated: 2026-01-01");
	});

	it("reports no changes for a no-op transform", () => {
		const result = mutateQuestFrontMatter(questDir, (fm) => fm);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.changes).toEqual([]);
	});

	it("journals the diff when an op is named", () => {
		mutateQuestFrontMatter(questDir, (fm) => ({ ...fm, priority: "driving" }), {
			op: "drive",
			questsRoot: root,
		});

		const journal = readFileSync(
			join(root, ".structural-journal.jsonl"),
			"utf8",
		);
		expect(journal).toContain('"op":"drive"');
		expect(journal).toContain('"field":"priority"');
	});
});

// The cast mirrors the drift the write-time gate must catch: a caller
// forcing an out-of-vocabulary value past the type system.
type QuestStatusCast = "active";
type QuestPriorityCast = "active";
