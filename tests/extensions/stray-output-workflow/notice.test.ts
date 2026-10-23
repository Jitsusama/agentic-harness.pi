/**
 * A caught write is kept whole and said in one line, and the same line
 * from the same writer is not said again within the quiet spell.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	NOTICE_QUIET_MS,
	noticeOf,
	strayHandler,
} from "../../../extensions/stray-output-workflow/notice.ts";
import { LOG_MAX_BYTES } from "../../../lib/internal/stray/log.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function logIn(): string {
	const dir = mkdtempSync(join(tmpdir(), "stray-"));
	dirs.push(dir);
	return join(dir, "nested", "stray.jsonl");
}

const thrown = {
	kind: "console.error",
	text: "Event handler error (mesh:lease:v1): Error: boom\n    at x (/h/extensions/mesh-workflow/index.ts:1:1)",
	stack: "    at y (/h/extensions/mesh-workflow/index.ts:2:2)",
};

describe("what becomes of a caught write", () => {
	it("keeps it whole with its stack and session, and says one line naming the writer", () => {
		const log = logIn();
		const said: string[] = [];
		const handle = strayHandler({
			log,
			logName: "~/stray.jsonl",
			session: "s1",
			notify: (text) => said.push(text),
			now: () => Date.UTC(2026, 9, 22, 23, 0),
		});

		handle(thrown);

		const kept = readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(kept).toEqual([
			{
				at: "2026-10-22T23:00:00.000Z",
				session: "s1",
				...thrown,
				line: "Error: boom",
				writer: "mesh-workflow",
				channel: "mesh:lease:v1",
			},
		]);
		expect(said).toEqual([
			"mesh-workflow's mesh:lease:v1 handler threw: Error: boom\nKept, with its stack, in ~/stray.jsonl.",
		]);
	});

	it("says the same line once a quiet spell, but keeps every one", () => {
		const log = logIn();
		const said: string[] = [];
		let clock = 0;
		const handle = strayHandler({
			log,
			notify: (text) => said.push(text),
			now: () => clock,
		});

		handle(thrown);
		clock += NOTICE_QUIET_MS - 1;
		handle(thrown);
		handle({ ...thrown, text: "another line" });
		clock += 1;
		handle(thrown);

		expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(4);
		expect(said).toHaveLength(3);
	});

	it("keeps writes and says nothing when there is nobody to tell", () => {
		const log = logIn();
		strayHandler({ log })({
			kind: "stderr",
			text: "between runtimes\n",
			stack: "",
		});
		expect(readFileSync(log, "utf8")).toContain("between runtimes");
	});

	it("moves a full log aside rather than growing it for good", () => {
		const log = logIn();
		strayHandler({ log })({ kind: "stderr", text: "first\n", stack: "" });
		writeFileSync(log, "x".repeat(LOG_MAX_BYTES + 1));

		strayHandler({ log })({ kind: "stderr", text: "after\n", stack: "" });

		expect(readFileSync(`${log}.1`, "utf8")).toHaveLength(LOG_MAX_BYTES + 1);
		expect(readFileSync(log, "utf8")).toContain("after");
	});

	it("words a write with no writer or channel plainly", () => {
		expect(noticeOf({ line: "hello" }, "~/l")).toBe(
			"Something wrote past the screen: hello\nKept, with its stack, in ~/l.",
		);
		expect(noticeOf({ line: "x", channel: "c:v1" }, "~/l")).toBe(
			"A c:v1 handler threw: x\nKept, with its stack, in ~/l.",
		);
	});
});
