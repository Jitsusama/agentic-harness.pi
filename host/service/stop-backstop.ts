/**
 * A stop's backstop: a thread beside the host's loop that ends the host
 * when its stop runs past the time it allows, so a loop held on a CPU,
 * which no timer of its own can interrupt, still ends short of systemd's
 * kill and says what it left unparked.
 */

import { writeSync } from "node:fs";
import { Worker } from "node:worker_threads";

/** Standard error, which the journal reads. */
const STDERR = 2;

/** What a backstop is armed with. */
export interface BackstopOptions {
	/** How long from now it waits before ending the host, in ms. */
	readonly within: number;
	/** Where it marks what was unparked, for the next start to read. */
	readonly file: string;
	/** The conversations unparked as the stop begins. */
	readonly ids: readonly string[];
	/** The descriptor its line is written to; standard error by default. */
	readonly fd?: number;
}

/** A backstop armed for one stop. */
export interface Backstop {
	/** Tell it which conversations are still unparked. */
	held(ids: readonly string[]): void;
	/** The stop ended on the loop: it ends without acting. */
	done(): void;
}

/** What the thread is handed. */
interface Armed {
	readonly within: number;
	readonly file: string;
	readonly ids: readonly string[];
	readonly fd: number;
	readonly pid: number;
	readonly began: number;
}

/**
 * The thread's whole program, as source so it runs the same whether this
 * module loaded as TypeScript or as JavaScript. It takes node's modules
 * through `process.getBuiltinModule`, which either module type has: a
 * thread takes its process's flags, so under a host started with
 * `--input-type=module` a `require` here threw and no backstop was armed
 * (23 November, in the host's own end-to-end runs). The line and the mark have
 * the shapes unparkedLine and unparkedMarks give them (stop.ts), so the
 * next start reads either alike. A kill is the one end a thread can give
 * its process, and the only one a held loop can't put off.
 */
const PROGRAM = `
const { parentPort, workerData } = process.getBuiltinModule("node:worker_threads");
const { mkdirSync, writeFileSync, writeSync } = process.getBuiltinModule("node:fs");
const { dirname } = process.getBuiltinModule("node:path");
const { within, file, fd, pid, began } = workerData;
let ids = workerData.ids;
parentPort.on("message", (told) => {
	if (told === "done") process.exit(0);
	else ids = told;
});
// From when it was armed, since a starved machine may be slow to start it,
// on the process's monotonic clock, which its threads share: a wall clock
// stepped either way can neither hold the end past systemd's kill nor bring
// it early.
const sinceArmed = () => Number(process.hrtime.bigint() / 1000000n) - began;
function fire() {
	// A timer may fire a millisecond early: never end it early. Both reads
	// are whole ms rounded down, so only a count past within is sure to be
	// within's whole time.
	const short = within - sinceArmed();
	if (short >= 0) {
		setTimeout(fire, short + 1);
		return;
	}
	const waited = sinceArmed();
	const left = ids.length > 0 ? ": " + ids.join(", ") : "";
	// The mark first, as a write to a journal that has stopped reading can block.
	if (ids.length > 0)
		try {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, JSON.stringify({ at: Date.now(), ids }));
		} catch {
			// The line names them; only the next start's note is lost.
		}
	try {
		writeSync(fd, "pi-host: stopping after " + waited + " ms, its loop held past the " + within + " ms its thread allows, " + ids.length + " not parked" + left + "; ending the host from that thread\\n");
	} catch {
		// With no journal to write to, the end still matters.
	}
	process.kill(pid, "SIGKILL");
}
setTimeout(fire, Math.max(0, within - sinceArmed()));
`;

/** The process's monotonic clock, in whole ms, as the thread reads it. */
function monotonicMs(): number {
	return Number(process.hrtime.bigint() / NS_PER_MS);
}

/** Nanoseconds in a millisecond, as hrtime counts them. */
const NS_PER_MS = 1_000_000n;

/** A backstop that couldn't start, leaving the stop to its loop's timer. */
const UNARMED: Backstop = { held() {}, done() {} };

/**
 * Arm a backstop for a stop beginning now: unless told the stop is done,
 * its thread ends the host once `within` ms have passed, saying in the
 * journal and marking at `file` the conversations it was last told were
 * unparked. The thread never keeps the process alive. One that can't
 * start says so, and leaves the stop bound by its loop's timer alone.
 */
export function backstopStop(options: BackstopOptions): Backstop {
	const armed: Armed = {
		within: options.within,
		file: options.file,
		ids: [...options.ids],
		fd: options.fd ?? STDERR,
		pid: process.pid,
		began: monotonicMs(),
	};
	const unarmed = (error: unknown) =>
		sayUnarmed(
			armed.fd,
			error instanceof Error ? error.message : String(error),
		);
	let thread: Worker;
	try {
		thread = new Worker(PROGRAM, { eval: true, workerData: armed });
	} catch (error) {
		unarmed(error);
		return UNARMED;
	}
	thread.unref();
	thread.on("error", unarmed);
	return {
		held(ids) {
			thread.postMessage([...ids]);
		},
		done() {
			thread.postMessage("done");
		},
	};
}

/** Say that a stop's backstop isn't armed, and why. */
function sayUnarmed(fd: number, why: string): void {
	try {
		writeSync(
			fd,
			`pi-host: couldn't arm the stop's backstop thread: ${why}; its loop's own bound is all that ends it\n`,
		);
	} catch {
		// With no journal to write to, there is nobody to tell.
	}
}
