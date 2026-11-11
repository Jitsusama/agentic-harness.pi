/**
 * The join a window's pi hands its window to as it moves into a pi host
 * in place (host/service/join.ts). Its holder starts it on the window's
 * terminal with the session's id after `--session`, which is how
 * mycelium's node knows the window is the hosted session's, and plain
 * pi's words after `--`:
 *
 *   node scripts/host-join.ts [--released] --session ID -- pi --session LOG [FLAGS]
 *
 * It draws nothing, unless a host holding the conversation is slow to
 * come back, when it says so in one line. Once the host has the
 * conversation open it names `mycelium attach --host` as what its holder
 * starts next, carrying on as this join with `--released` should the
 * host let the conversation go; should the move be taken back, plain
 * pi's words. With `--released`, it names plain pi's words once no host
 * holds the conversation. Either way it writes its wake and exits as a
 * park does, so its holder starts that at once on the same terminal,
 * where the keys typed meanwhile still wait.
 */

import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { joinMove, joinRelease } from "../host/service/join.ts";
import { hostHold, viewingWords } from "../lib/internal/session/host-holds.ts";
import {
	noteState,
	restoreStrandedClaims,
	takeBackMove,
} from "../lib/internal/session/move.ts";
import {
	AGAIN_ENV,
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
if (!own.includes("--session") || session === "" || plainPi.length === 0) {
	throw new Error("Usage: host-join.ts --session ID -- PLAIN PI WORDS");
}
if (wake === "" || again === "") {
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
const joined = own.includes("--released")
	? await joinRelease(looking)
	: await joinMove({
			...looking,
			noted: () => noteState(session),
			restoreStranded: () => restoreStrandedClaims(alive),
			takeBack: () => takeBackMove(session, process.pid),
		});
// Released, the window carries on as this join again, which waits for the
// host to let the log go before plain pi takes it up.
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
writeFileSync(again, JSON.stringify(next));
writeFileSync(
	wake,
	JSON.stringify({ session, joined: joined.to, at: new Date().toISOString() }),
);
process.exitCode = PARKED_EXIT;
