import {
	closeSync,
	mkdtempSync,
	openSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
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

	it("answers from a log far too large to hold as a string", () => {
		// A real 1.2 GB session log made this throw: V8 caps a string
		// near 512 MB, so reading the whole file allocated a gigabyte and
		// then failed, leaving the session permanently unresolvable.
		// Only the end of the log decides the answer.
		const path = join(dir, "huge.jsonl");
		const filler = JSON.stringify({
			type: "message",
			message: { role: "user", content: "x".repeat(4096) },
		});
		const handle = openSync(path, "w");
		try {
			for (let written = 0; written < 8_000_000; written += filler.length) {
				writeSync(handle, `${filler}\n`);
			}
			writeSync(
				handle,
				`${JSON.stringify({
					type: "custom",
					customType: "quest-workflow",
					data: { questId: "QEST-LATE" },
				})}\n`,
			);
		} finally {
			closeSync(handle);
		}
		expect(authoritativeQuestFromLog(path)).toBe("QEST-LATE");
	});

	it("reads only the tail, so an entry buried deep is out of reach", () => {
		// The honest cost of bounding the read: a quest named only near
		// the start of an enormous log is not found. Undefined is the
		// right answer for that, and it is what an unreadable log
		// already returns, so no caller learns a new failure mode.
		const path = join(dir, "deep.jsonl");
		const handle = openSync(path, "w");
		try {
			writeSync(
				handle,
				`${JSON.stringify({
					type: "custom",
					customType: "quest-workflow",
					data: { questId: "QEST-BURIED" },
				})}\n`,
			);
			const filler = JSON.stringify({ type: "message", pad: "x".repeat(4096) });
			for (let written = 0; written < 8_000_000; written += filler.length) {
				writeSync(handle, `${filler}\n`);
			}
		} finally {
			closeSync(handle);
		}
		expect(authoritativeQuestFromLog(path)).toBeUndefined();
	});

	it("returns undefined for an unreadable log", () => {
		expect(
			authoritativeQuestFromLog(join(dir, "missing.jsonl")),
		).toBeUndefined();
	});
});
