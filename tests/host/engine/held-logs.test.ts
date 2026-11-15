/**
 * The logs a host holds open: one descriptor a conversation, read-only,
 * moved to the log a conversation became, let go once released, and a
 * log that can't be opened said rather than thrown. Counted from
 * /proc/self/fd, which only Linux has.
 */
import {
	mkdtempSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { heldLogs } from "../../../host/engine/held-logs.ts";

const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0))
		rmSync(folder, { recursive: true, force: true });
});

/** Two written logs in a folder of their own. */
function twoLogs(): { first: string; second: string } {
	// Past any link, as /proc names what a descriptor is open on.
	const folder = realpathSync(mkdtempSync(join(tmpdir(), "held-logs-")));
	folders.push(folder);
	const first = join(folder, "first.jsonl");
	const second = join(folder, "second.jsonl");
	writeFileSync(first, "{}\n");
	writeFileSync(second, "{}\n");
	return { first, second };
}

/** How many of this process's descriptors are open on `file`. */
function opened(file: string): number {
	return readdirSync("/proc/self/fd").filter((fd) => {
		try {
			return readlinkSync(`/proc/self/fd/${fd}`) === file;
		} catch {
			// Closed between the listing and the look, as the listing's own is.
			return false;
		}
	}).length;
}

describe.skipIf(process.platform !== "linux")("a host's held logs", () => {
	it("holds a conversation's log once, however often it is held", () => {
		const { first } = twoLogs();
		const logs = heldLogs((error) => {
			throw error;
		});
		logs.hold("one", first);
		logs.hold("one", first);
		expect(opened(first)).toBe(1);
		logs.release("one");
		expect(opened(first)).toBe(0);
	});

	it("moves to the log a conversation holds now, letting the last go", () => {
		const { first, second } = twoLogs();
		const logs = heldLogs((error) => {
			throw error;
		});
		logs.hold("one", first);
		logs.hold("one", second);
		expect([opened(first), opened(second)]).toEqual([0, 1]);
		logs.release("one");
		logs.release("one");
		expect(opened(second)).toBe(0);
	});

	it("says a log it can't open, holding nothing for it", () => {
		const { first } = twoLogs();
		const reported: unknown[] = [];
		const logs = heldLogs((error) => reported.push(error));
		const missing = `${first}.gone`;
		logs.hold("one", missing);
		expect(reported).toHaveLength(1);
		expect(String(reported[0])).toContain("ENOENT");
		logs.release("one");
		expect(reported).toHaveLength(1);
	});
});
