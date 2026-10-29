/**
 * Every session log a span holds: those still on the machine, and those
 * only on Drive, found through session-backup's index and read back one
 * at a time, each copy removed once read so none outlives the run.
 *
 * session-backup removes a log from the machine 90 days after its last
 * write, once Drive holds its copy, and keeps a row for every log it sent
 * in `$XDG_STATE_HOME/session-backup/index.jsonl`. So a sensor reading
 * further back than 90 days reads the machine's logs, then asks the index
 * for the sessions it lacks.
 */
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isRecord } from "./record.ts";

/** A log on Drive only, as the index names it. */
export interface AwayLog {
	/** The object Drive holds it as, which `session-backup fetch` reads. */
	readonly name: string;
	/** Its session, or null for a log that isn't pi's. */
	readonly id: string | null;
	/** Its last entry's time. */
	readonly ended: string;
}

/** The logs a span holds. */
export interface SessionLogs {
	/** Paths of the logs on the machine written in the span. */
	readonly here: string[];
	/** The sessions in the span that are on Drive only. */
	readonly away: AwayLog[];
}

/** Read the copy Drive holds as `name` back to the path `to`. */
export type FetchLog = (name: string, to: string) => void;

/** What reading the logs on Drive only gave. */
export interface AwayRead<T> {
	/** What the reader made of each copy read back. */
	readonly read: T[];
	/** How many couldn't be read back. */
	readonly unread: number;
	/** Why the last of those couldn't. */
	readonly why?: string;
}

/** Where session-backup keeps its index, by the XDG base directories. */
export function backupIndexPath(home = homedir()): string {
	const state = process.env.XDG_STATE_HOME;
	const root =
		state && state.length > 0 ? state : join(home, ".local", "state");
	return join(root, "session-backup", "index.jsonl");
}

/**
 * The logs holding anything from `sinceMs` on: the machine's logs written
 * since then, and each session the index says ended since then that has
 * no log on the machine, from its last copy.
 */
export function sessionLogs(
	sinceMs: number,
	where: { readonly sessionsDir: string; readonly indexPath: string },
): SessionLogs {
	const here = logsHere(where.sessionsDir, sinceMs);
	const sessionsHere = new Set(here.map(sessionOf));
	const last = new Map<string, AwayLog>();
	for (const log of indexed(where.indexPath)) {
		if (Date.parse(log.ended) < sinceMs) continue;
		if (log.id !== null && sessionsHere.has(log.id)) continue;
		const key = log.id ?? log.name;
		const seen = last.get(key);
		if (!seen || Date.parse(seen.ended) < Date.parse(log.ended)) {
			last.set(key, log);
		}
	}
	return { here, away: [...last.values()] };
}

/**
 * What `read` makes of each of `logs`, read back through `fetch` into a
 * folder of their own that is removed before this returns. Each copy is
 * read at the same path, so `read` is given the log too, to say which
 * session it was. A copy that
 * can't be read back is counted and passed over; when session-backup
 * isn't on the machine at all, none is tried after the first. A failure
 * of `read` itself is the caller's, and is thrown on.
 */
export function readAway<T>(
	logs: readonly AwayLog[],
	read: (path: string, log: AwayLog) => T,
	fetch: FetchLog = fetchWithBackup,
): AwayRead<T> {
	const folder = mkdtempSync(join(tmpdir(), "away-logs-"));
	const results: T[] = [];
	let unread = 0;
	let why: string | undefined;
	try {
		for (const [at, log] of logs.entries()) {
			const copy = join(folder, "log.jsonl");
			try {
				fetch(log.name, copy);
			} catch (error) {
				if (isMissingProgram(error)) {
					unread += logs.length - at;
					why = "session-backup isn't on this machine to read them back";
					break;
				}
				unread += 1;
				why = error instanceof Error ? error.message : String(error);
				continue;
			}
			try {
				results.push(read(copy, log));
			} finally {
				rmSync(copy, { force: true });
			}
		}
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
	return why === undefined
		? { read: results, unread }
		: { read: results, unread, why };
}

/** Read a copy back with the account's own `session-backup fetch`. */
function fetchWithBackup(name: string, to: string): void {
	execFileSync("session-backup", ["fetch", name, "--to", to], {
		stdio: ["ignore", "ignore", "pipe"],
	});
}

/** Whether a failure was the program not being there to run. */
function isMissingProgram(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

/** The session a log on the machine holds, from its file name. */
function sessionOf(path: string): string {
	const name = basename(path, ".jsonl");
	return name.slice(name.lastIndexOf("_") + 1);
}

/** Paths of the logs under `root` written since `sinceMs`. */
function logsHere(root: string, sinceMs: number): string[] {
	let folders: string[];
	try {
		folders = readdirSync(root);
	} catch {
		// No sessions folder: nothing is on the machine.
		return [];
	}
	return folders.flatMap((folder) => {
		let names: string[];
		try {
			names = readdirSync(join(root, folder));
		} catch {
			// A file beside the session folders, not a folder.
			return [];
		}
		return names
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => join(root, folder, name))
			.filter((path) => writtenSince(path, sinceMs));
	});
}

/** Whether a log was written since `sinceMs`, so it can hold anything since. */
function writtenSince(path: string, sinceMs: number): boolean {
	try {
		return statSync(path).mtimeMs >= sinceMs;
	} catch {
		// Removed since it was listed: nothing to read.
		return false;
	}
}

/** The index's rows, each a log on Drive. */
function indexed(path: string): AwayLog[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		// No index: session-backup isn't here, or hasn't sent a log yet.
		return [];
	}
	return text.split("\n").flatMap((line) => {
		let row: unknown;
		try {
			row = JSON.parse(line);
		} catch {
			// A line cut short, as a run stopped mid-write leaves.
			return [];
		}
		if (!isRecord(row)) return [];
		const { name, id, ended } = row;
		if (typeof name !== "string" || typeof ended !== "string") return [];
		return [{ name, id: typeof id === "string" ? id : null, ended }];
	});
}
