/**
 * The turns a capture drafts from are the whole session's, those a
 * held or rolled-over log left on disk included.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionTurns } from "../../../extensions/correction-capture/session-turns.ts";
import { ROLLOVER_RECORD } from "../../../lib/internal/session/rollover.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "capture-turns-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const said = (id: string, parentId: string | null, text: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-11-22T00:00:00.000Z",
	message: { role: "user", content: text, timestamp: 0 },
});

describe("the turns a capture drafts from", () => {
	it("begin with those the log left on disk", () => {
		const parent = join(dir, "parent.jsonl");
		const header = { type: "session", id: "s1", timestamp: "", cwd: dir };
		const lines = [header, said("e1", null, "Never sign off unsigned.")];
		writeFileSync(
			parent,
			`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
		);
		const manager = SessionManager.inMemory(dir);
		manager.appendCustomEntry(ROLLOVER_RECORD, {
			parentSession: parent,
			parentLeaf: "e1",
			carried: {},
		});
		manager.appendMessage({ role: "user", content: "Later.", timestamp: 0 });

		expect(sessionTurns(manager)).toEqual([
			{ role: "user", text: "Never sign off unsigned." },
			{ role: "user", text: "Later." },
		]);
	});

	it("are the log's own when it carries on from no other", () => {
		const manager = SessionManager.inMemory(dir);
		manager.appendMessage({ role: "user", content: "Only.", timestamp: 0 });

		expect(sessionTurns(manager)).toEqual([{ role: "user", text: "Only." }]);
	});
});
