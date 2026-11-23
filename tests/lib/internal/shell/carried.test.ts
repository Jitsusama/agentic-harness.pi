/**
 * A carried bash call, watched in the process a move took it to: its
 * end read from what it kept, a shell gone with no status said as lost
 * with its output, and a stop or a time limit killing its work.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CALLS_WATCHED_MS,
	type CarriedShell,
	carriesMark,
	isCarriedShell,
	provedCall,
	watchCarried,
	withinWatch,
} from "../../../../lib/internal/shell/carried.ts";
import { makeKept } from "../../../../lib/internal/shell/kept.ts";

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A carried call's work, its files made fresh. */
async function carried(
	extra: Partial<CarriedShell> = {},
): Promise<CarriedShell> {
	const dir = mkdtempSync(join(tmpdir(), "carried-"));
	made.push(dir);
	return {
		kind: "shell",
		keep: await makeKept(dir),
		pid: 4242,
		mark: "mark-1",
		startedAt: 1000,
		...extra,
	};
}

/** Looks every millisecond, so a test waits on nothing but the looks. */
const QUICK = 1;

// A pid reused by another process after a restart is not the call's shell.
describe("whether a pid is still the call it was", () => {
	const environ = (entries: string[]) => () => `${entries.join("\0")}\0`;

	it("is when its environment carries the call's mark", () => {
		expect(
			carriesMark(4242, "m1", environ(["PATH=/bin", "PI_BASH_CALL=m1"])),
			"a pid whose environment carries the mark is the call",
		).toBe(true);
	});

	it("is not when it carries another mark or none", () => {
		expect(
			carriesMark(4242, "m1", environ(["PI_BASH_CALL=m2"])),
			"another call's mark is not this call",
		).toBe(false);
		expect(
			carriesMark(4242, "m1", environ(["PATH=/bin"])),
			"a pid with no mark is not this call",
		).toBe(false);
	});

	it("leaves the pid to say when its environment can't be read", () => {
		expect(
			carriesMark(4242, "m1", () => {
				throw new Error("EACCES");
			}),
			"an unreadable environment leaves the pid to say",
		).toBe(true);
	});

	// A kill leans on proof: the record outlives the call, and its pid may
	// lead anyone's group by then (#1981 F71).
	it("is proved only by an environment read that carries the mark, and never for pid 1 or below", () => {
		const marked = environ(["PI_BASH_CALL=m1"]);
		expect(provedCall(4242, "m1", marked), "read, with the mark").toBe(true);
		expect(
			provedCall(4242, "m1", environ(["PI_BASH_CALL=m2"])),
			"another's mark",
		).toBe(false);
		expect(
			provedCall(4242, "m1", () => {
				throw new Error("EACCES");
			}),
			"unreadable proves nothing",
		).toBe(false);
		for (const pid of [1, 0, -1, 1.5])
			expect(provedCall(pid, "m1", marked), `pid ${pid}`).toBe(false);
	});
});

describe("whether a call is still within its watch", () => {
	it("is until its time limit, and for a day after it started", () => {
		const now = 10 * CALLS_WATCHED_MS;
		expect(withinWatch({ startedAt: now }, now), "fresh").toBe(true);
		expect(
			withinWatch({ startedAt: now, deadline: now + 1 }, now),
			"before its limit",
		).toBe(true);
		expect(
			withinWatch({ startedAt: now, deadline: now }, now),
			"at its limit",
		).toBe(false);
		expect(
			withinWatch({ startedAt: now - CALLS_WATCHED_MS + 1 }, now),
			"just inside a day",
		).toBe(true);
		expect(
			withinWatch({ startedAt: now - CALLS_WATCHED_MS }, now),
			"a day old",
		).toBe(false);
	});
});

describe("a carried call's watch", () => {
	it("reads the status it wrote as it ended, with its output", async () => {
		const work = await carried();
		const watch = watchCarried(work, new AbortController().signal, {
			everyMs: QUICK,
			alive: () => true,
		});
		writeFileSync(`${work.keep}.out`, "one\ntwo\n");
		writeFileSync(`${work.keep}.end`, "3\n");
		expect(await watch.ended).toEqual({
			how: "exited",
			code: 3,
			output: "one\ntwo\n",
		});
	});

	it("says a shell gone with no status as lost, with what it printed", async () => {
		const work = await carried();
		writeFileSync(`${work.keep}.out`, "last words\n");
		const watch = watchCarried(work, new AbortController().signal, {
			everyMs: QUICK,
			alive: () => false,
		});
		expect(await watch.ended).toEqual({ how: "lost", output: "last words\n" });
	});

	it("kills its work when stopped", async () => {
		const work = await carried();
		const stopped: CarriedShell[] = [];
		const stop = new AbortController();
		const watch = watchCarried(work, stop.signal, {
			everyMs: QUICK,
			alive: () => true,
			stop: (one) => stopped.push(one),
		});
		stop.abort();
		expect(await watch.ended).toEqual({ how: "stopped" });
		expect(stopped, "its group and mark were killed").toEqual([work]);
	});

	it("kills its work once its time limit runs out", async () => {
		const work = await carried({ deadline: 5000 });
		const stopped: CarriedShell[] = [];
		const watch = watchCarried(work, new AbortController().signal, {
			everyMs: QUICK,
			alive: () => true,
			now: () => 5000,
			stop: (one) => stopped.push(one),
		});
		expect((await watch.ended).how).toBe("timed-out");
		expect(stopped, "its work was killed").toEqual([work]);
	});

	it("lets it run on when it moves again", async () => {
		const work = await carried();
		const stopped: CarriedShell[] = [];
		const watch = watchCarried(work, new AbortController().signal, {
			everyMs: QUICK,
			alive: () => true,
			stop: (one) => stopped.push(one),
		});
		watch.handed();
		expect(await watch.ended).toEqual({ how: "handed" });
		expect(stopped, "nothing was killed").toEqual([]);
	});
});

describe("carried work", () => {
	it("is taken as a bash call only when it says all a watch needs", async () => {
		expect(isCarriedShell(await carried()), "a whole call").toBe(true);
		expect(
			isCarriedShell({ kind: "shell", keep: "/k", pid: 1, startedAt: 1 }),
			"one with no mark",
		).toBe(false);
		expect(isCarriedShell({ kind: "subagent" }), "another kind").toBe(false);
	});

	it("says whether it prints the environment only by a yes or a no", async () => {
		expect(
			isCarriedShell({ ...(await carried()), dumps: true }),
			"one that prints it",
		).toBe(true);
		expect(
			isCarriedShell({ ...(await carried()), dumps: "yes" }),
			"one that says it otherwise",
		).toBe(false);
	});
});
