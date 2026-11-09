/**
 * The service's durable roster for one realm-kind host, behind one lock.
 *
 * Holds are written before the engine registers a conversation and only
 * dropped after a deliberate close or release commits, so a crash at any
 * point leaves a conversation held rather than lost. Stopping the host
 * leaves every hold in place for the next start to resume.
 */
import { randomBytes } from "node:crypto";
import {
	chmod,
	link,
	lstat,
	mkdir,
	open,
	readFile,
	rename,
	unlink,
} from "node:fs/promises";
import { resolve } from "node:path";
import { isOwner } from "../../lib/core/process/index.ts";
import {
	parseRoster,
	type Roster,
	type RosterEntry,
	rosterDir,
	rosterPath,
} from "../../lib/core/session/roster.ts";
import {
	keepTicks,
	type Standing,
	type TickedOwner,
	tickedOwnerNow,
	tickedStanding,
} from "../../lib/internal/process-ticks.ts";
import { writeWhole } from "../../lib/internal/write-whole.ts";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/** The open roster of one host key, writable only by its lock holder. */
export interface HostRoster {
	readonly key: string;
	/** What was held at start or since, for the engine to resume. */
	entries(): readonly RosterEntry[];
	/** Persist a hold before the engine registers the conversation. */
	hold(entry: RosterEntry): Promise<void>;
	/** Remove a hold once a close or release has committed. */
	drop(sessionId: string): Promise<void>;
	/** Release the lock, keeping every hold for the next start. */
	close(): Promise<void>;
}

/** Acquire a key's lock and read its roster, refusing on any doubt. */
export async function openRoster(options: {
	key: string;
	dir?: string;
	owner?: TickedOwner;
	standing?: (owner: TickedOwner) => Promise<Standing>;
}): Promise<HostRoster> {
	const dir = options.dir ?? rosterDir();
	const path = rosterPath(options.key, dir);
	const owner = options.owner ?? (await tickedOwnerNow());
	if (!owner) throw new Error("Host cannot name its own process");
	await privateDirectory(dir);
	const lock = `${path}.lock`;
	const mine = JSON.stringify({ key: options.key, owner });
	await acquire(lock, mine, options.standing ?? tickedStanding);
	let sessions: RosterEntry[];
	try {
		sessions = [...(await existing(path, options.key))];
		if (sessions.length === 0) persist(path, options.key, sessions);
	} catch (error) {
		await releaseLock(lock, mine);
		throw error;
	}
	let queue = Promise.resolve();
	let closed = false;
	function change(update: (current: RosterEntry[]) => RosterEntry[]) {
		const next = queue.then(async () => {
			if (closed) throw new Error("Roster is closed");
			const updated = update(sessions);
			persist(path, options.key, updated);
			await syncDirectory(dir);
			sessions = updated;
		});
		queue = next.catch(() => {
			// The failed caller sees its own error; later changes still run.
		});
		return next;
	}
	return {
		key: options.key,
		entries: () => [...sessions],
		hold: (entry) =>
			change((current) => {
				const file = resolve(entry.file);
				if (
					current.some(
						(held) =>
							held.sessionId === entry.sessionId || resolve(held.file) === file,
					)
				)
					throw new Error("Conversation is already held");
				return [...current, { ...entry, file }];
			}),
		drop: (sessionId) =>
			change((current) =>
				current.filter((held) => held.sessionId !== sessionId),
			),
		async close() {
			await queue;
			if (closed) return;
			closed = true;
			await releaseLock(lock, mine);
		},
	};
}

async function privateDirectory(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: DIRECTORY_MODE });
	const info = await lstat(dir);
	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		info.uid !== process.getuid?.()
	)
		throw new Error("Roster folder must be a directory this user owns");
	if ((info.mode & 0o777) !== DIRECTORY_MODE) await chmod(dir, DIRECTORY_MODE);
}

async function existing(path: string, key: string): Promise<RosterEntry[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isCode(error, "ENOENT")) return [];
		throw error;
	}
	const roster = parseRoster(text, key);
	// Never overwrite a roster nobody can read: it may be the only record
	// of conversations a crashed host held.
	if (!roster) throw new Error(`Roster is unreadable; inspect ${path}`);
	return [...roster.sessions];
}

function persist(path: string, key: string, sessions: RosterEntry[]): void {
	const roster: Roster = { v: 1, key, sessions };
	writeWhole(path, `${JSON.stringify(roster, null, "\t")}\n`, {
		durable: true,
	});
}

async function syncDirectory(dir: string): Promise<void> {
	const handle = await open(dir, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function acquire(
	lock: string,
	mine: string,
	standing: (owner: TickedOwner) => Promise<Standing>,
): Promise<void> {
	if (await create(lock, mine)) return;
	const seen = await readLock(lock);
	const holder = lockOwner(seen);
	if (!holder) throw new Error(`Roster lock is unreadable; inspect ${lock}`);
	const verdict = await standing(holder);
	if (verdict !== "gone")
		throw new Error(
			verdict === "running"
				? "Another host holds this roster"
				: "Cannot tell whether the roster's last host still runs",
		);
	// Move the dead holder's lock aside rather than unlinking it, then
	// confirm it was the one judged dead: a contender that took over in
	// between gets its lock put back, and this start refuses.
	const aside = `${lock}.${randomBytes(4).toString("hex")}.stale`;
	await rename(lock, aside);
	if ((await readLock(aside)) !== seen) {
		await link(aside, lock).catch(() => {
			// Someone else holds the lock already; theirs stands.
		});
		await unlink(aside);
		throw new Error("Another host took this roster during takeover");
	}
	await unlink(aside);
	if (!(await create(lock, mine)))
		throw new Error("Another host took this roster during takeover");
}

async function create(lock: string, content: string): Promise<boolean> {
	try {
		const handle = await open(lock, "wx", FILE_MODE);
		try {
			await handle.writeFile(content);
			await handle.sync();
		} finally {
			await handle.close();
		}
		return true;
	} catch (error) {
		if (isCode(error, "EEXIST")) return false;
		throw error;
	}
}

async function readLock(lock: string): Promise<string | undefined> {
	try {
		return await readFile(lock, "utf8");
	} catch {
		// Gone or unreadable: the caller treats it as an unknown holder.
		return undefined;
	}
}

async function releaseLock(lock: string, mine: string): Promise<void> {
	// Only remove the lock while it is still this host's.
	if ((await readLock(lock)) === mine) await unlink(lock);
}

function lockOwner(text: string | undefined): TickedOwner | undefined {
	if (text === undefined) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== "object" || value === null || !("owner" in value))
			return undefined;
		return isOwner(value.owner) ? keepTicks(value.owner) : undefined;
	} catch {
		// A malformed lock names nobody; the caller refuses to take it.
		return undefined;
	}
}

function isCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}
