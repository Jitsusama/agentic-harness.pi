/**
 * The join a window's pi hands its window to as it moves into a pi host
 * in place (host/service/join.ts). Its holder starts it on the window's
 * terminal with the session's id after `--session`, which is how
 * mycelium's node knows the window is the hosted session's, and plain
 * pi's words after `--`:
 *
 *   node scripts/host-join.ts [--released|--view] --session ID -- pi --session LOG [FLAGS]
 *
 * It draws nothing, unless a host holding the conversation is slow to
 * come back, when it says so in one line. Once the host has the
 * conversation open it names `mycelium attach --host` as what its holder
 * starts next, carrying on as this join with `--released` should the
 * host let the conversation go; should the move be taken back, plain
 * pi's words. With `--released`, it names plain pi's words once no host
 * holds the conversation. With `--view`, as a window the launcher opens
 * on a hosted conversation runs it, it looks once: the host's attach
 * while any host holds it, else plain pi. Under its own holder, one whose
 * record names this process, it writes its wake and exits as a park
 * does, so its holder starts that at once on the same terminal, where
 * the keys typed meanwhile still wait. Should the attach fail rather
 * than be released, the window carries on as this join all the same,
 * which says so and looks again. Under none, a view or a release runs
 * it itself, ending as it ends.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	joinAfterFailedAttach,
	joinMove,
	joinRelease,
	joinView,
} from "../host/service/join.ts";
import {
	ATTACH_FAILED_ENV,
	hostHold,
	viewingWords,
} from "../lib/internal/session/host-holds.ts";
import {
	noteState,
	restoreStrandedClaims,
	takeBackMove,
} from "../lib/internal/session/move.ts";
import {
	AGAIN_ENV,
	heldDirectly,
	PARKED_EXIT,
	WAKE_ENV,
} from "../lib/internal/session/park.ts";

const args = process.argv.slice(2);
const split = args.indexOf("--");
const own = split === -1 ? args : args.slice(0, split);
const plainPi = split === -1 ? [] : args.slice(split + 1);
const session = own[own.indexOf("--session") + 1] ?? "";
const wake = process.env[WAKE_ENV] ?? "";
const again = process.env[AGAIN_ENV] ?? "";
// Set by the viewing words when the attach before this join failed, not
// released; gone from here on, so what this join runs next starts clean.
const failed = process.env[ATTACH_FAILED_ENV] ?? "";
Reflect.deleteProperty(process.env, ATTACH_FAILED_ENV);
if (!own.includes("--session") || session === "" || plainPi.length === 0) {
	throw new Error("Usage: host-join.ts --session ID -- PLAIN PI WORDS");
}
// Under no holder, as a window opened by a caller that can't hold one
// runs a view's words, it runs what comes next itself and ends as that
// does; only a holder lets the window go on past it. The variables alone
// don't say this join is held: a window opened from a shell under some
// pi's holder inherits them, and on 11 November one wrote that pi's
// holder a wake and exited, closing the window, so the holder's record
// must name this process.
const held = wake !== "" && again !== "" && heldDirectly(wake, process.pid);
if (!held && !own.includes("--view") && !own.includes("--released")) {
	throw new Error(
		"host-join.ts runs under a mycelium holder, which names its wake",
	);
}

/** Whether a pid still runs, as signal 0 says. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it runs, as another user's.
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

const looking = {
	hold: () => hostHold(session),
	say: (line: string) => process.stdout.write(`\r\n${line}\r\n`),
	now: Date.now,
	pause: (ms: number) => delay(ms),
};
/** Where the window goes next, as its words ask. */
function joining() {
	if (own.includes("--released") && failed !== "")
		return joinAfterFailedAttach(looking, failed);
	if (own.includes("--released")) return joinRelease(looking);
	if (own.includes("--view")) return joinView(looking);
	return joinMove({
		...looking,
		noted: () => noteState(session),
		restoreStranded: () => restoreStrandedClaims(alive),
		takeBack: () => takeBackMove(session, process.pid),
	});
}
const joined = await joining();
// Released, the window carries on as this join again, which waits for the
// host to let the log go before plain pi takes it up; after a failed
// attach, it carries on as this join too, which looks again.
const released = [
	process.execPath,
	fileURLToPath(import.meta.url),
	"--released",
	"--session",
	session,
	"--",
	...plainPi,
];
const next =
	joined.to === "host" ? viewingWords(joined.hold, session, released) : plainPi;
if (held) {
	writeFileSync(again, JSON.stringify(next));
	writeFileSync(
		wake,
		JSON.stringify({
			session,
			joined: joined.to,
			at: new Date().toISOString(),
		}),
	);
	process.exitCode = PARKED_EXIT;
} else {
	const [program = "", ...words] = next;
	const ran = spawnSync(program, words, { stdio: "inherit" });
	process.exitCode = ran.status ?? 1;
}
