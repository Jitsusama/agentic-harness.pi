import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authoritativeQuestFromLog } from "../../../../lib/internal/quest/session-ownership";

let dir: string;

function logFile(lines: object[]): string {
	const path = join(dir, "session.jsonl");
	writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
	return path;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-ownership-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("authoritativeQuestFromLog", () => {
	it("returns the questId of the last quest-workflow entry", () => {
		const path = logFile([
			{
				type: "custom",
				customType: "quest-workflow",
				data: { questId: "QEST-A" },
			},
			{ type: "message", message: { role: "user" } },
			{
				type: "custom",
				customType: "quest-workflow",
				data: { questId: "QEST-B" },
			},
		]);
		expect(authoritativeQuestFromLog(path)).toBe("QEST-B");
	});

	it("ignores a trailing quest-workflow entry that cleared the quest", () => {
		const path = logFile([
			{
				type: "custom",
				customType: "quest-workflow",
				data: { questId: "QEST-A" },
			},
			{ type: "custom", customType: "quest-workflow", data: { questId: null } },
		]);
		expect(authoritativeQuestFromLog(path)).toBeUndefined();
	});

	it("returns undefined when the log has no quest-workflow entry", () => {
		const path = logFile([{ type: "message", message: { role: "user" } }]);
		expect(authoritativeQuestFromLog(path)).toBeUndefined();
	});

	it("returns undefined for an unreadable log", () => {
		expect(
			authoritativeQuestFromLog(join(dir, "missing.jsonl")),
		).toBeUndefined();
	});
});
