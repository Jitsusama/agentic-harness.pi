import { describe, expect, it } from "vitest";
import {
	judgeRecordWrite,
	type RecordWrite,
} from "../../../../lib/core/internal/quest/record-gate.ts";

const roots = { questsRoot: "/quests", workspaceRoot: "/cache/ws" };
const quest = "QEST-20260924-ABC123";
const q = (rel: string) => `/quests/${quest}${rel ? `/${rel}` : ""}`;
const judge = (write: Partial<RecordWrite> & { path: string }) =>
	judgeRecordWrite(
		{ effect: "write", via: "bash", exists: false, ...write },
		roots,
	);

describe("judgeRecordWrite", () => {
	it("passes what the record allows", () => {
		const allowed: (Partial<RecordWrite> & { path: string })[] = [
			{ path: q("plans/PLAN-20260924-RUE4Q4.md"), via: "tool", exists: true },
			{ path: q("README.md"), via: "tool", exists: true },
			{ path: q("attachments/cost.png") },
			{ path: q("attachments/runs/a/summary.md"), via: "tool" },
			{ path: q("attachments") },
			{ path: q("") },
			{ path: q("plans") },
			{ path: q("attachments/cost.png"), effect: "remove" },
			{ path: q("lab/old.csv"), effect: "remove" },
			{ path: "/elsewhere/file.txt" },
			{ path: "/quests/index.json" },
		];
		for (const write of allowed) {
			expect(judge(write), JSON.stringify(write)).toBeUndefined();
		}
	});

	it("sends a new document through quest draft", () => {
		const refusal = judge({
			path: q("plans/PLAN-20260924-NEW001.md"),
			via: "tool",
		});
		expect(refusal?.rule).toBe("document-by-hand");
		expect(refusal?.reason).toContain("`quest draft`");
	});

	it("keeps bash out of documents and the README", () => {
		for (const rel of ["plans/PLAN-20260924-RUE4Q4.md", "README.md"]) {
			const refusal = judge({ path: q(rel), exists: true });
			expect(refusal?.rule, rel).toBe("document-by-bash");
			expect(refusal?.reason, rel).toContain("edit or write tool");
		}
	});

	it("sends a hand write to the Journey through quest journal", () => {
		for (const via of ["tool", "bash"] as const) {
			const refusal = judge({ path: q("JOURNEY.md"), via, exists: true });
			expect(refusal?.rule, via).toBe("journey-by-hand");
			expect(refusal?.reason, via).toContain("`quest journal`");
		}
	});

	it("keeps documents, the README, record folders and the quest from being removed", () => {
		const cases: [string, string][] = [
			["JOURNEY.md", "document-removed"],
			["plans/PLAN-20260924-RUE4Q4.md", "document-removed"],
			["plans/*.md", "document-removed"],
			["README.md", "document-removed"],
			["plans", "document-removed"],
			["attachments", "document-removed"],
			["", "document-removed"],
		];
		for (const [rel, rule] of cases) {
			const refusal = judge({ path: q(rel), effect: "remove", exists: true });
			expect(refusal?.rule, rel).toBe(rule);
			expect(refusal?.reason, rel).toContain("`quest retire`");
		}
	});

	it("sends a stray to the workspace, naming where", () => {
		const refusal = judge({ path: q("lab/results.csv") });
		expect(refusal).toEqual({
			rule: "stray",
			reason: expect.stringContaining(
				"README, its JOURNEY.md, its documents and attachments/",
			),
			instead: `/cache/ws/${quest}/lab/results.csv`,
		});
		expect(refusal?.reason).toContain(`/cache/ws/${quest}/lab/results.csv`);
	});

	it("mentions attachments/ for a stray a document could cite", () => {
		expect(
			judge({ path: q("research/notes.md"), via: "tool" })?.reason,
		).toContain("attachments/notes.md");
		expect(judge({ path: q("lab/run.jsonl") })?.reason).not.toContain(
			"attachments/run.jsonl",
		);
	});

	it("sends raw data out of attachments into the workspace", () => {
		const refusal = judge({ path: q("attachments/runs/events.jsonl") });
		expect(refusal?.rule).toBe("attachment");
		expect(refusal?.instead).toBe(`/cache/ws/${quest}/runs/events.jsonl`);
		expect(refusal?.reason).toContain("raw data");
	});

	it("judges any quest's folder, not only one that is loaded", () => {
		expect(
			judge({ path: "/quests/QEST-20260101-OTHER1/scratch/x.txt" })?.instead,
		).toBe("/cache/ws/QEST-20260101-OTHER1/scratch/x.txt");
	});
});
