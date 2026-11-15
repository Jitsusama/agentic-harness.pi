/**
 * The process that owns a session holds its log open, read-only, for as
 * long as it owns it, so mycelium can believe a presence's claim only
 * where its owner holds that log (5HJZ8Z [9a66b4c0], 15 November). A
 * helper the session starts never inherits it.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { holdSessionLog } from "../../../extensions/mesh-workflow/held-log.ts";

/** What this process holds open, as paths. */
function heldHere(): string[] {
	return readdirSync("/proc/self/fd").flatMap((fd) => {
		try {
			return [readlinkSync(join("/proc/self/fd", fd))];
		} catch {
			// Closed between the listing and the read, as readdir's own is.
			return [];
		}
	});
}

/** A fresh folder, by its real path, as a held descriptor names it. */
const aFolder = () => realpathSync(mkdtempSync(join(tmpdir(), "held-log-")));

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A pi that keeps its handlers, and a session whose log is `file()`. */
function aPi(file: () => string | undefined) {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (name: string, handler: Handler) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	};
	const ctx = { sessionManager: { getSessionFile: file } };
	const fire = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	return { pi, fire };
}

const shutdowns: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const shutdown of shutdowns.splice(0)) await shutdown();
});

describe.skipIf(!existsSync("/proc/self/fd"))("a session's own log", () => {
	it("is held open once pi has written it, and let go when the session ends", async () => {
		const log = join(aFolder(), "s.jsonl");
		const { pi, fire } = aPi(() => log);
		holdSessionLog(pi as never);
		shutdowns.push(() => fire("session_shutdown"));

		await fire("session_start", { reason: "startup" });
		expect(heldHere(), "held before pi wrote it").not.toContain(log);
		writeFileSync(log, '{"type":"session"}\n');
		await fire("agent_end");
		expect(heldHere(), "not held once written").toContain(log);
		await fire("agent_end");
		expect(
			heldHere().filter((path) => path === log),
			"held more than once",
		).toHaveLength(1);

		await fire("session_shutdown");
		expect(heldHere(), "still held after the session ended").not.toContain(log);
	});

	it("moves to the new log when the session forks or rolls over", async () => {
		const folder = aFolder();
		const first = join(folder, "a.jsonl");
		const second = join(folder, "b.jsonl");
		writeFileSync(first, "{}\n");
		writeFileSync(second, "{}\n");
		let current = first;
		const { pi, fire } = aPi(() => current);
		holdSessionLog(pi as never);
		shutdowns.push(() => fire("session_shutdown"));

		await fire("session_start", { reason: "startup" });
		expect(heldHere()).toContain(first);
		current = second;
		await fire("session_start", { reason: "fork" });
		expect(heldHere(), "the new log isn't held").toContain(second);
		expect(heldHere(), "the old log is still held").not.toContain(first);
	});

	it("is never handed to a command the session starts", async () => {
		const log = join(aFolder(), "s.jsonl");
		writeFileSync(log, "{}\n");
		const { pi, fire } = aPi(() => log);
		holdSessionLog(pi as never);
		shutdowns.push(() => fire("session_shutdown"));
		await fire("session_start", { reason: "startup" });
		expect(heldHere()).toContain(log);

		const child = execFileSync("sh", ["-c", "ls -l /proc/$$/fd"], {
			encoding: "utf8",
		});
		expect(child, "a child inherited the log").not.toContain(log);
	});

	it("holds nothing for a session that keeps no log", async () => {
		const before = heldHere().length;
		const { pi, fire } = aPi(() => undefined);
		holdSessionLog(pi as never);
		await fire("session_start", { reason: "startup" });
		await fire("agent_end");
		expect(heldHere().length, "something was opened").toBeLessThanOrEqual(
			before,
		);
	});
});
