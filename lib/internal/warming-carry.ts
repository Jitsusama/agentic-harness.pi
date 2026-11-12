/**
 * An idle session's warming as kept on disk while no pi runs it: the
 * last request it sent, when its cache entry was last refreshed and how
 * many warms it has had. A session writes it as it shuts down for
 * anything but a reload, a pi host warms it on while the session is
 * parked, and the session's next start takes it back.
 *
 * The carry holds the conversation, so it is compressed, readable only
 * by its owner, written whole (a reader never sees half of one) and
 * holds no header that could carry a credential; its writer leaves
 * those out. A warm the host sends while the session is parked is kept
 * in a folder of its own, as a line of the record a warm leaves, for
 * the session's next start to record in its log, which no other writer
 * touches.
 */

import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { stateDir } from "./paths.ts";
import { isRecord } from "./record.ts";
import { writeWhole } from "./write-whole.ts";

/** What a session's warming carries while no pi runs it. */
export interface WarmingCarry {
	readonly sessionId: string;
	/** The last request the session's own turn sent, as it was sent. */
	readonly payload: unknown;
	/** Its headers, with none that could hold a credential. */
	readonly headers: Readonly<Record<string, string | null>>;
	readonly provider: string;
	readonly modelId: string;
	/** When the request was sent. */
	readonly at: number;
	/** When its cache entry was last read or written, by a turn or a warm. */
	readonly refreshedAt: number;
	/** The warms it has had since the request. */
	readonly warms: number;
}

/** No pending warm is kept longer than this for a session that never starts. */
export const PENDING_WARMS_LIFETIME_MS = 7 * 24 * 60 * 60_000;

/** Readable and writable by the owner alone: it is the conversation. */
const OWNER_ONLY = 0o600;
const OWNER_ONLY_DIR = 0o700;

/** Where warming carries live. */
export function warmingCarryDir(): string {
	return join(stateDir("compaction-workflow"), "warming");
}

/** Where warms sent while a session was parked wait for its next start. */
export function pendingWarmsDir(): string {
	return join(stateDir("compaction-workflow"), "warming-pending");
}

/** A session id as a file's name, with nothing that could leave the folder. */
function nameFor(sessionId: string): string {
	return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

const carryFile = (dir: string, sessionId: string) =>
	join(dir, `${nameFor(sessionId)}.json.gz`);

const pendingFile = (dir: string, sessionId: string) =>
	join(dir, `${nameFor(sessionId)}.jsonl`);

/** Write a session's carry whole, compressed and readable only by its owner. */
export function writeWarmingCarry(dir: string, carry: WarmingCarry): void {
	mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR });
	writeWhole(carryFile(dir, carry.sessionId), gzipSync(JSON.stringify(carry)), {
		mode: OWNER_ONLY,
	});
}

/** A session's carry, left where it is, or nothing when none reads as one. */
export function readWarmingCarry(
	dir: string,
	sessionId: string,
): WarmingCarry | null {
	let raw: Buffer;
	try {
		raw = readFileSync(carryFile(dir, sessionId));
	} catch {
		// No file is the usual case: nothing was kept for this session.
		return null;
	}
	try {
		const carry: unknown = JSON.parse(gunzipSync(raw).toString("utf8"));
		return isCarry(carry) && carry.sessionId === sessionId ? carry : null;
	} catch {
		// A file that will not read is one nobody can use.
		return null;
	}
}

/** A session's carry taken back, its file removed, or nothing. */
export function takeWarmingCarry(
	dir: string,
	sessionId: string,
): WarmingCarry | null {
	const carry = readWarmingCarry(dir, sessionId);
	rmSync(carryFile(dir, sessionId), { force: true });
	return carry;
}

/** Keep a warm sent while the session was parked, for its next start. */
export function addPendingWarm(
	dir: string,
	sessionId: string,
	record: Readonly<Record<string, unknown>>,
): void {
	mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR });
	appendFileSync(pendingFile(dir, sessionId), `${JSON.stringify(record)}\n`, {
		mode: OWNER_ONLY,
	});
}

/** The warms kept for a session while it was parked, taken once. */
export function takePendingWarms(
	dir: string,
	sessionId: string,
): Record<string, unknown>[] {
	const file = pendingFile(dir, sessionId);
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		// None kept: its host sent no warm while it was parked.
		return [];
	}
	rmSync(file, { force: true });
	return text.split("\n").flatMap((line) => {
		try {
			const record: unknown = line === "" ? undefined : JSON.parse(line);
			return isRecord(record) ? [record] : [];
		} catch {
			// A line cut short by a crash as it was appended says nothing.
			return [];
		}
	});
}

/** Remove what was kept for sessions that have not started in a week. */
export function sweepPendingWarms(dir: string, now = Date.now()): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		// Nothing has been kept yet, so there is nothing to sweep.
		return;
	}
	for (const name of names) {
		const file = join(dir, name);
		try {
			if (now - statSync(file).mtimeMs > PENDING_WARMS_LIFETIME_MS)
				rmSync(file, { force: true });
		} catch {
			// Taken by its session as it was looked at, which is the same end.
		}
	}
}

function isCarry(value: unknown): value is WarmingCarry {
	if (!isRecord(value) || !isRecord(value.headers)) return false;
	return (
		typeof value.sessionId === "string" &&
		"payload" in value &&
		typeof value.provider === "string" &&
		typeof value.modelId === "string" &&
		typeof value.at === "number" &&
		typeof value.refreshedAt === "number" &&
		typeof value.warms === "number" &&
		Object.values(value.headers).every(
			(header) => typeof header === "string" || header === null,
		)
	);
}
