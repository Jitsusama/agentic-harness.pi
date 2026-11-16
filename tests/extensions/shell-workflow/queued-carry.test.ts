/**
 * A bash call the machine's queue holds, with a time limit, is carried
 * through a move or a host restart like any other call: the hand-off
 * finds it by the signal pi ran it under, takes its deadline with it,
 * and the limit no longer stops it here once it is handed on.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	COMMAND_STUB,
	KEEP_VARIABLE,
} from "../../../extensions/shell-workflow/command-line.ts";
import { keepsOnDisk } from "../../../extensions/shell-workflow/keeping.ts";
import { timedKeeping } from "../../../extensions/shell-workflow/timed-keeping.ts";
import { CALL_VARIABLE } from "../../../lib/internal/shell/reap.ts";
import type { CarriedWork, JobCarry } from "../../../lib/jobs/index.ts";
import { quietFor, until } from "../../support/until.ts";

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A shell that writes its pid where keeping looks, and ends only on a stop. */
function shell(): BashOperations & { stopped: () => boolean } {
	let stopped = false;
	return {
		stopped: () => stopped,
		exec: (_command, _cwd, call) =>
			new Promise((resolve) => {
				const keep = call.env?.[KEEP_VARIABLE];
				if (keep) writeFileSync(`${keep}.pid`, `${process.pid}\n`);
				call.signal?.addEventListener("abort", () => {
					stopped = true;
					resolve({ exitCode: 1 });
				});
			}),
	};
}

/** Operations keeping each call, timed from its turn, in a folder of their own. */
function operations(queued: boolean, pollMs = 10) {
	const dir = mkdtempSync(join(tmpdir(), "queued-carry-"));
	made.push(dir);
	const running = shell();
	const keeping = keepsOnDisk(running, {
		can: () => true,
		folder: () => join(dir, "kept"),
	});
	const timed = timedKeeping(keeping, {
		pollMs,
		commandOf: () =>
			queued
				? `__queue='${dir}' __job='j1' __since=$SECONDS\necho hi`
				: "echo hi",
	});
	return { dir, running, ...timed };
}

/** What a carry answers once it answers `ready`, polled until then. */
async function carried(
	carry: () => JobCarry | undefined,
	ready: (what: CarriedWork) => boolean = () => true,
): Promise<{ carry: JobCarry; what: CarriedWork }> {
	let seen: { carry: JobCarry; what: CarriedWork } | undefined;
	await until(
		"the call to be carried",
		() => {
			const now = carry();
			const what = now?.what();
			if (now && what && ready(what)) seen = { carry: now, what };
			return seen !== undefined;
		},
		2_000,
	);
	if (!seen) throw new Error("until returned with nothing carried");
	return seen;
}

/** Starts a call under a signal of the caller's, as pi does. */
function start(ops: BashOperations, timeout: number) {
	const caller = new AbortController();
	const ended = ops
		.exec(COMMAND_STUB, "/", {
			onData: () => undefined,
			signal: caller.signal,
			timeout,
			env: { ...process.env, [CALL_VARIABLE]: "m1" },
		})
		.catch((error: unknown) => error);
	return { caller, ended };
}

describe("a queued call with a time limit", () => {
	it("is carried, found by the signal pi ran it under", async () => {
		const at = operations(true);
		const { caller, ended } = start(at.operations, 600);
		writeFileSync(join(at.dir, "j1.began"), "");
		const { what } = await carried(() => at.carryOf(caller.signal));
		expect(what?.kind, "the queued call is carried as a shell").toBe("shell");
		caller.abort();
		await ended;
	});

	it("takes the time left of its limit as its deadline", async () => {
		const at = operations(true);
		const before = Date.now();
		const { caller, ended } = start(at.operations, 600);
		writeFileSync(join(at.dir, "j1.began"), "");
		const { what } = await carried(
			() => at.carryOf(caller.signal),
			(found) => found.kind === "shell" && found.deadline !== undefined,
		);
		const deadline =
			typeof what.deadline === "number" ? what.deadline : undefined;
		expect(deadline, "a deadline goes with the call").toBeDefined();
		expect(deadline ?? 0, "no later than the whole limit from its start").toBe(
			Math.min(deadline ?? 0, Date.now() + 600_000),
		);
		expect(deadline ?? 0, "no sooner than the limit less what it ran").toBe(
			Math.max(deadline ?? 0, before + 590_000),
		);
		caller.abort();
		await ended;
	});

	it("is no longer stopped here at its limit once handed on", async () => {
		const at = operations(true);
		const { caller, ended } = start(at.operations, 1);
		writeFileSync(join(at.dir, "j1.began"), "");
		const { carry } = await carried(() => at.carryOf(caller.signal));
		carry.handed();
		// Past the one-second limit, the watch looking every 10 ms.
		await quietFor(10, 150);
		expect(at.running.stopped(), "the handed shell runs on").toBe(false);
		caller.abort();
		await ended;
	});
});

describe("a call the queue doesn't hold", () => {
	it("is carried as before", async () => {
		const at = operations(false);
		const { caller, ended } = start(at.operations, 600);
		const { what } = await carried(() => at.carryOf(caller.signal));
		expect(what?.kind, "the plain call is carried as a shell").toBe("shell");
		caller.abort();
		await ended;
	});
});
