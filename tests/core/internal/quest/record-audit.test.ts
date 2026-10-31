import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachmentProblem } from "../../../../lib/core/internal/quest/record.ts";
import {
	attachmentFileAt,
	auditQuestRecord,
	isRecordSound,
} from "../../../../lib/core/internal/quest/record-audit.ts";

const QUEST = "QEST-20260924-ABC123";
let root: string;
let questDir: string;

function put(rel: string, content: string | Uint8Array = "x\n"): void {
	const path = join(questDir, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "record-audit-"));
	questDir = join(root, QUEST);
	put("README.md", "# Quest\n\n![Cost](attachments/cost.png)\n");
	put(
		"plans/PLAN-20260924-RUE4Q4.md",
		"See `attachments/runs/` and [gone](../attachments/gone.md).\n",
	);
	put("attachments/cost.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]));
	put("attachments/runs/a.md");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("auditQuestRecord", () => {
	it("finds nothing wrong with a sound record beyond a broken link", () => {
		const audit = auditQuestRecord(questDir);
		expect(audit).toEqual({
			strays: [],
			attachments: [],
			broken: [
				{
					document: "plans/PLAN-20260924-RUE4Q4.md",
					target: "../attachments/gone.md",
				},
			],
			uncited: [],
		});
		expect(isRecordSound(audit)).toBe(false);
	});

	it("reports each stray by its outermost path", () => {
		put("lab/deep/a.csv");
		put("lab/b.csv");
		put("research/notes.md");
		put("research/sub/RSCH-20260924-AAAAAA.md");
		put("PLAN-20260924-RUE4Q4.md");
		expect(auditQuestRecord(questDir).strays).toEqual([
			"PLAN-20260924-RUE4Q4.md",
			"lab",
			"research/notes.md",
			"research/sub",
		]);
	});

	it("reports attachments that break the limits, without descending into a checkout", () => {
		put("attachments/events.jsonl");
		put("attachments/blob", new Uint8Array([1, 0, 2]));
		put("attachments/repo/.git/HEAD");
		put("attachments/repo/.git/objects/aa/bb");
		symlinkSync("/etc/hosts", join(questDir, "attachments/hosts"));
		const found = auditQuestRecord(questDir).attachments.map(
			(entry) => `${entry.rel}: ${entry.problem.reason}`,
		);
		expect(found).toEqual([
			"attachments/blob: binary",
			"attachments/events.jsonl: raw-data",
			"attachments/hosts: not-a-file",
			"attachments/repo/.git: in-a-checkout",
		]);
	});

	it("lists attachments no document cites", () => {
		put("attachments/lonely.md");
		expect(auditQuestRecord(questDir).uncited).toEqual([
			"attachments/lonely.md",
		]);
	});

	it("keeps the Journey and counts what it cites", () => {
		put("attachments/notes.md");
		put(
			"JOURNEY.md",
			"# Journey\n\n- **2026-09-24**: See attachments/notes.md.\n",
		);
		const audit = auditQuestRecord(questDir);
		expect(audit.strays).toEqual([]);
		expect(audit.uncited).not.toContain("attachments/notes.md");
	});

	it("passes over the writer's .writing and lock, wherever they sit", () => {
		put(".writing/quest.lock");
		put(".writing/README.md.123.abcd0123");
		put("plans/.writing/PLAN-20260924-RUE4Q4.md.123.abcd0123");
		put(".quest.lock");
		put(".README.md.tmp-123-abc");
		expect(auditQuestRecord(questDir).strays).toEqual([]);
	});

	it("keeps the harness log without reading it for citations", () => {
		put("attachments/notes.md");
		put("harness.log", "2026-10-26T05:01:02Z Wrote attachments/notes.md.\n");
		const audit = auditQuestRecord(questDir);
		expect(audit.strays).toEqual([]);
		expect(audit.uncited).toContain("attachments/notes.md");
	});

	it("calls a record with only uncited attachments sound", () => {
		put("plans/PLAN-20260924-RUE4Q4.md", "See `attachments/runs/`.\n");
		put("attachments/lonely.md");
		expect(isRecordSound(auditQuestRecord(questDir))).toBe(true);
	});
});

describe("attachmentFileAt", () => {
	it("reads a file the way the audit judges it, wherever it sits", () => {
		put("evidence/blob", new Uint8Array([1, 0, 2]));
		put("evidence/notes.md");
		symlinkSync("/etc/hosts", join(questDir, "evidence", "hosts"));
		const problem = (rel: string) =>
			attachmentProblem(attachmentFileAt(join(questDir, rel), rel))?.reason;
		expect(problem("evidence/blob")).toBe("binary");
		expect(problem("evidence/notes.md")).toBeUndefined();
		expect(problem("evidence/hosts")).toBe("not-a-file");
	});
});
