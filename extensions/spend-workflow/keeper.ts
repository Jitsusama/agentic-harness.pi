/**
 * Keeping the ledger current without anyone asking, and saying how
 * current it is.
 *
 * Only the `spend` tool indexed, so a day when no session asked left
 * the ledger hours behind, and whatever read it outside pi (the spend
 * cards) showed old figures as if they were today's. Now one idle pi on
 * the machine runs a pass every half hour under a lease, and every pass,
 * the tool's or the keeper's, writes a stamp beside the ledger: when it
 * ran, what it read, and the error when it failed. A reader that finds
 * the stamp old or failed knows not to trust the figures.
 */

import {
	closeSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hosted } from "../../lib/core/session/index.ts";
import { stateDir } from "../../lib/internal/paths.ts";
import { writeWhole } from "../../lib/internal/write-whole.ts";
import type { IndexOutcome } from "./report.ts";

/** The stamp every pass writes, beside the ledger. */
const STAMP_NAME = "ledger-indexed.json";

/** The lease a keeper holds while its pass runs. */
export const LEASE_NAME = "ledger-pass.lease";

/** How old the newest pass may be before the keeper runs another. */
export const PASS_EVERY_MS = 30 * 60_000;

/** How often a keeper looks whether a pass is due. */
const LOOK_EVERY_MS = 5 * 60_000;

/** How long its session must have been still before a keeper runs. */
const STILL_FOR_MS = 2 * 60_000;

/**
 * A lease older than this is taken over whoever holds it. A pass after
 * a day unread took seven minutes, so anything this old is a holder
 * that stopped rather than one still reading.
 */
const LEASE_STALE_MS = 30 * 60_000;

/** What the last pass did, as written beside the ledger. */
interface PassStamp {
	/** When the pass ended, as an ISO time. */
	readonly at: string;
	/** Whether it finished. */
	readonly ok: boolean;
	/** The pid that ran it. */
	readonly pid: number;
	/** Who asked: the spend tool or the keeper. */
	readonly by: "tool" | "keeper";
	/** How long it took, in seconds. */
	readonly seconds: number;
	/** Logs read and turns new to the ledger, when it finished. */
	readonly scanned?: number;
	readonly inserted?: number;
	/** Of those, how many were read from where the last pass stopped. */
	readonly resumed?: number;
	/** Why each log that carried something was read whole instead. */
	readonly refused?: readonly string[];
	/** Why it failed, when it did. */
	readonly error?: string;
}

function isStamp(value: unknown): value is PassStamp {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.at === "string" &&
		typeof candidate.ok === "boolean" &&
		!Number.isNaN(Date.parse(candidate.at))
	);
}

/** The last pass's stamp in `dir`, or undefined when none reads. */
export function readStamp(dir: string): PassStamp | undefined {
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(join(dir, STAMP_NAME), "utf8"),
		);
		return isStamp(parsed) ? parsed : undefined;
	} catch {
		// No stamp yet, or one cut short: either way no pass is known to
		// have run, which is what an absent stamp says.
		return undefined;
	}
}

/**
 * Run one pass and stamp what it did, whether it finished or failed.
 * A failure is stamped and then thrown again, so the caller still
 * hears it.
 */
export async function stampedPass(
	dir: string,
	by: PassStamp["by"],
	pass: () => Promise<IndexOutcome>,
): Promise<IndexOutcome> {
	const started = Date.now();
	const stamp = (fields: Partial<PassStamp>): void => {
		const whole: PassStamp = {
			at: new Date().toISOString(),
			ok: false,
			pid: process.pid,
			by,
			seconds: (Date.now() - started) / 1000,
			...fields,
		};
		writeWhole(join(dir, STAMP_NAME), `${JSON.stringify(whole)}\n`);
	};
	let outcome: IndexOutcome;
	try {
		outcome = await pass();
	} catch (error) {
		stamp({ ok: false, error: describe(error) });
		throw error;
	}
	stamp({
		ok: true,
		seconds: outcome.seconds,
		scanned: outcome.scanned,
		inserted: outcome.inserted,
		resumed: outcome.resumed,
		...(outcome.refused.length > 0 ? { refused: outcome.refused } : {}),
	});
	return outcome;
}

/** Whether a pass is due: none has run, or the last is old or failed. */
export function passDue(
	stamp: PassStamp | undefined,
	now: number,
	every = PASS_EVERY_MS,
): boolean {
	if (!stamp?.ok) return true;
	return now - Date.parse(stamp.at) >= every;
}

/**
 * Take the lease for a pass, or undefined when a live holder has it.
 * The lease names its holder's pid, so one left by a process that has
 * gone is taken over at once, and one older than any pass takes is
 * taken over whoever it names. The release removes the lease only while
 * it is still this holder's.
 */
export function claimLease(
	dir: string,
	now = Date.now(),
	staleMs = LEASE_STALE_MS,
): (() => void) | undefined {
	const path = join(dir, LEASE_NAME);
	const mine = String(process.pid);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const fd = openSync(path, "wx");
			let ino: number;
			try {
				writeSync(fd, mine);
				ino = statSync(path).ino;
			} finally {
				closeSync(fd);
			}
			return () => {
				try {
					if (statSync(path).ino === ino) rmSync(path);
				} catch {
					// Taken over and removed already: nothing of ours is left.
				}
			};
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
		}
		if (!leaseLeft(path, now, staleMs)) return undefined;
		rmSync(path, { force: true });
	}
	return undefined;
}

/** Whether the lease at `path` was left by a holder no longer passing. */
function leaseLeft(path: string, now: number, staleMs: number): boolean {
	try {
		const age = now - statSync(path).mtimeMs;
		if (age > staleMs) return true;
		const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
		// A lease with no pid yet is one being made, not one left.
		if (!Number.isFinite(pid) || pid <= 0) return false;
		return !alive(pid);
	} catch (error) {
		// Released between the failed create and here: free to take.
		if (hasCode(error, "ENOENT")) return true;
		throw error;
	}
}

function alive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM is a process that exists and belongs to somebody else.
		return hasCode(error, "EPERM");
	}
}

/** What a keeper needs from the session it runs in. */
interface KeeperDeps {
	/** The folder holding the ledger and its stamp. */
	readonly dir: () => string;
	/** Whether the session has been still long enough to read logs in. */
	readonly still: () => boolean;
	/** Run one pass, as the spend tool would. */
	readonly pass: () => Promise<IndexOutcome>;
	readonly now?: () => number;
}

/**
 * Look whether a pass is due, and run it when this session is still,
 * the stamp says one is due and nobody else holds the lease. Answers
 * what it did, for a test to read; a failed pass is in the stamp.
 */
export async function keepOnce(
	deps: KeeperDeps,
): Promise<"ran" | "failed" | "busy" | "current" | "held"> {
	if (!deps.still()) return "busy";
	const now = deps.now?.() ?? Date.now();
	const dir = deps.dir();
	if (!passDue(readStamp(dir), now)) return "current";
	const release = claimLease(dir, now);
	if (!release) return "held";
	try {
		// Another keeper may have finished between the look and the lease.
		if (!passDue(readStamp(dir), deps.now?.() ?? Date.now())) {
			return "current";
		}
		await stampedPass(dir, "keeper", deps.pass);
		return "ran";
	} catch {
		// The stamp holds the failure, which is where every reader of the
		// ledger looks; the next look tries again.
		return "failed";
	} finally {
		release();
	}
}

/**
 * Keep the ledger from this session while it lives: a session with a
 * person at it, or a host's. A subagent's pass would be one more reader
 * of every log for nothing, since its parent's session keeps the ledger
 * as well. `pass` is the spend tool's own, so the two share a pass
 * under way rather than run two.
 */
export function registerKeeper(
	pi: ExtensionAPI,
	pass: () => Promise<IndexOutcome>,
): void {
	// Whether a run is under way, and when one last moved, so a pass
	// reads logs only in a session nobody is working in.
	let running = false;
	let lastMoved = Date.now();
	let stop: (() => void) | null = null;
	pi.on("agent_start", () => {
		running = true;
		lastMoved = Date.now();
	});
	pi.on("agent_settled", () => {
		running = false;
		lastMoved = Date.now();
	});
	pi.on("session_start", (_event, ctx) => {
		if (stop || !(ctx.hasUI || hosted())) return;
		stop = startKeeper({
			dir: () => stateDir("observability"),
			still: () => !running && Date.now() - lastMoved >= STILL_FOR_MS,
			pass,
		});
	});
	pi.on("session_shutdown", () => {
		stop?.();
		stop = null;
	});
}

/** Start looking every few minutes; answers how to stop. */
function startKeeper(deps: KeeperDeps, every = LOOK_EVERY_MS): () => void {
	let looking = false;
	const timer = setInterval(() => {
		if (looking) return;
		looking = true;
		void keepOnce(deps).finally(() => {
			looking = false;
		});
	}, every);
	timer.unref();
	return () => clearInterval(timer);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function hasCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}
