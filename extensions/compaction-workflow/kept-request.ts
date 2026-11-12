/**
 * The last request a session sent, kept across a restart of pi.
 *
 * The conversation provider summarises from the request the session
 * last sent, which it holds in memory. A `/reload` hands it across in
 * the process (see `conversation.ts`), but quitting pi and resuming the
 * session loses it, and the first compaction after that falls back to
 * pi's summariser even though the provider's cache still holds the
 * conversation for up to an hour. So on a shutdown that is not a
 * reload, the request is written to disk, and the next start of the
 * same session takes it back, once.
 *
 * The request is the whole conversation, so the file is compressed and
 * readable only by its owner, and lives no longer than the longest
 * cache that could still answer for it: anything older is swept when a
 * session starts. `PI_COMPACTION_KEEP_REQUEST=off` keeps nothing on
 * disk at all.
 *
 * Idle warming keeps what it would carry across a restart by the same
 * rules, in a folder of its own (`lib/internal/warming-carry.ts`), and
 * sweeps it with `sweepKeptRequests`.
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { stateDir } from "../../lib/internal/paths.ts";

/** What the provider holds about the last request the session sent. */
export interface SentRequest {
	readonly payload: unknown;
	readonly leafId: string | null;
	readonly modelId: string | undefined;
	readonly at: number;
}

/** No cache a provider keeps outlives this, so neither does the file. */
export const KEPT_REQUEST_LIFETIME_MS = 60 * 60_000;

/** Readable and writable by the owner alone: it is the conversation. */
const OWNER_ONLY = 0o600;
const OWNER_ONLY_DIR = 0o700;

/** Where kept requests live unless a caller says otherwise. */
export function keptRequestDir(): string {
	return join(stateDir("compaction-workflow"), "requests");
}

/** Whether keeping requests on disk is switched on. */
export function keepingRequests(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_COMPACTION_KEEP_REQUEST?.toLowerCase() !== "off";
}

/** A session id as a file name, with nothing that could leave the dir. */
function fileFor(dir: string, sessionId: string): string {
	return join(dir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json.gz`);
}

/**
 * Write a session's last request to disk. A failure costs only the
 * cheaper first compaction after a restart, so it is swallowed.
 */
export function saveKeptRequest(
	dir: string,
	sessionId: string,
	sent: SentRequest,
): void {
	saveKept(dir, sessionId, { sessionId, sent });
}

/**
 * Write `value` for a session to `dir`, compressed and readable only by
 * its owner. A failure costs only a cheaper start, so it is swallowed.
 */
function saveKept(dir: string, sessionId: string, value: unknown): void {
	try {
		mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR });
		writeFileSync(fileFor(dir, sessionId), gzipSync(JSON.stringify(value)), {
			mode: OWNER_ONLY,
		});
	} catch {
		// Deliberately dropped: shutting down must not fail over a cache
		// the next start can do without.
	}
}

/**
 * Take what was kept for a session back, removing its file, or nothing
 * when there is none or it will not read. The caller checks its shape.
 */
function takeKept(dir: string, sessionId: string): unknown {
	const file = fileFor(dir, sessionId);
	let raw: Buffer;
	try {
		raw = readFileSync(file);
	} catch {
		// No file is the usual case: nothing was kept for this session.
		return null;
	}
	rmSync(file, { force: true });
	try {
		return JSON.parse(gunzipSync(raw).toString("utf8"));
	} catch {
		// A file that will not read is one we cannot use; it is gone now.
		return null;
	}
}

/**
 * Take a session's kept request back, removing the file, or nothing
 * when there is none, it belongs to another session, or it is older
 * than any cache that could still answer for it.
 */
export function takeKeptRequest(
	dir: string,
	sessionId: string,
	now: number = Date.now(),
): SentRequest | null {
	const kept = takeKept(dir, sessionId);
	if (!isKept(kept) || kept.sessionId !== sessionId) return null;
	if (now - kept.sent.at > KEPT_REQUEST_LIFETIME_MS) return null;
	return kept.sent;
}

/** Remove every kept file older than any cache that could use it. */
export function sweepKeptRequests(dir: string, now: number = Date.now()): void {
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
			if (now - statSync(file).mtimeMs > KEPT_REQUEST_LIFETIME_MS) {
				rmSync(file, { force: true });
			}
		} catch {
			// Another session took or swept it first, which is the same end.
		}
	}
}

function isKept(
	value: unknown,
): value is { sessionId: string; sent: SentRequest } {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.sessionId !== "string") return false;
	const sent = v.sent as Record<string, unknown> | null;
	return (
		typeof sent === "object" &&
		sent !== null &&
		"payload" in sent &&
		typeof sent.at === "number" &&
		(sent.leafId === null || typeof sent.leafId === "string") &&
		(sent.modelId === undefined || typeof sent.modelId === "string")
	);
}
