/**
 * Finds and ends what a conversation's tools left running.
 *
 * pi starts each bash command as a process group of its own, built from the
 * conversation's environment, and kills that group only when the command is
 * aborted or times out. A stop, or a host killed outright, leaves it running,
 * so the next start would report a tool cut off while it carried on. Each
 * conversation's environment carries markers naming it, its host's key and
 * the host process that owns it, which every child and descendant inherits.
 * Reaping one conversation finds every process carrying its marker and kills
 * its group; reaping what a host left behind, at the next start under its
 * key, finds every process under that key whose owning host no longer runs,
 * whatever conversation it was for, held or not. A host holds its key alone,
 * so another live host's children are never touched. A reused pid carries no marker, so it is never mistaken for a
 * child, and an owner is its pid and the tick it started at, which no later
 * process with that pid shares. Linux's /proc is the process table.
 *
 * A command a move or a release handed to another process runs on under
 * the marks of the conversation that started it, so its group is spared
 * (`carriedGroups`, lib/internal/shell/kept.ts) until its end is said.
 */
import { readdirSync, readFileSync } from "node:fs";
import { carriedGroups } from "../../lib/internal/shell/kept.ts";

/** The variable naming the conversation a process was started for. */
export const CONVERSATION_MARKER = "PI_HOST_CONVERSATION";

/** The variable naming the key of the host whose conversation started a process. */
export const KEY_MARKER = "PI_HOST_KEY";

/** The variable naming the host process whose conversation started a process. */
export const OWNER_MARKER = "PI_HOST_OWNER";

/** How many times reaping looks again, for a child forked while it killed. */
const MOST_PASSES = 3;

/** Where the group sits after a stat line's command: state, parent, group. */
const GROUP_FIELD = 2;

/** Where the start time sits after a stat line's command, in clock ticks since boot. */
const START_FIELD = 19;

/** The process table reaping reads and the kill it sends. */
export interface ProcessTable {
	/** This process's own id, never reaped. */
	readonly self: number;
	/** Every process id the table holds. */
	pids(): readonly number[];
	/** A process's environment, or undefined once it is gone or unreadable. */
	environ(pid: number): Readonly<Record<string, string>> | undefined;
	/** A process's group, or undefined once it is gone. */
	group(pid: number): number | undefined;
	/** When a process started, in ticks since boot, or undefined once it is gone. */
	started(pid: number): number | undefined;
	/** Kill a whole group, or one process when the group is this one's own. */
	kill(target: { group: number } | { pid: number }): void;
}

/** What was killed: whole groups, and lone processes in the host's own group. */
export interface Reaped {
	readonly groups: number[];
	readonly pids: number[];
}

/** The host a conversation runs under: its key, and its process's owner mark. */
export interface HostMark {
	readonly key: string;
	readonly mark: string;
}

/** The environment entries that mark a process as one conversation's, under the host that owns it. */
export function conversationMarker(
	sessionId: string,
	owner: HostMark,
): Record<string, string> {
	return {
		[CONVERSATION_MARKER]: sessionId,
		[KEY_MARKER]: owner.key,
		[OWNER_MARKER]: owner.mark,
	};
}

/** This process's mark as an owner: its pid and the tick it started at. */
export function ownerMark(table: ProcessTable = linuxProcessTable()): string {
	const started = table.started(table.self);
	if (started === undefined)
		throw new Error("The host cannot read when its own process started");
	return `${table.self}:${started}`;
}

/**
 * Kill every process group holding a process this conversation's tools
 * started, answering the groups and lone processes it killed.
 */
export function reapToolChildren(
	sessionId: string,
	table: ProcessTable = linuxProcessTable(),
	spared: ReadonlySet<number> = carriedGroups(),
): Reaped {
	return reapWhere(
		(environ) => environ[CONVERSATION_MARKER] === sessionId,
		table,
		spared,
	);
}

/**
 * Kill every process group holding a process a host under this key started
 * and no longer runs, answering what it killed. Nothing else would end them:
 * a host that does not resume their conversation never reaps it by name.
 */
export function reapLeftBehind(
	key: string,
	table: ProcessTable = linuxProcessTable(),
	spared: ReadonlySet<number> = carriedGroups(),
): Reaped {
	return reapWhere(
		(environ) => {
			const owner = environ[OWNER_MARKER];
			return (
				environ[KEY_MARKER] === key &&
				owner !== undefined &&
				!runs(owner, table)
			);
		},
		table,
		spared,
	);
}

/** Every process other than this one carrying the conversation's marker. */
export function marked(sessionId: string, table: ProcessTable): number[] {
	return markedWhere(
		(environ) => environ[CONVERSATION_MARKER] === sessionId,
		table,
	);
}

/** Whether the host an owner mark names still runs as the same process. */
function runs(owner: string, table: ProcessTable): boolean {
	const colon = owner.indexOf(":");
	const pid = Number(owner.slice(0, colon));
	const started = Number(owner.slice(colon + 1));
	return colon > 0 && Number.isInteger(pid) && table.started(pid) === started;
}

function reapWhere(
	chosen: (environ: Readonly<Record<string, string>>) => boolean,
	table: ProcessTable,
	spared: ReadonlySet<number>,
): Reaped {
	const own = table.group(table.self);
	const groups = new Set<number>();
	const pids = new Set<number>();
	for (let pass = 0; pass < MOST_PASSES; pass += 1) {
		const found = markedWhere(chosen, table);
		if (found.length === 0) break;
		for (const pid of found) {
			const group = table.group(pid);
			// Gone meanwhile, or handed on and said elsewhere.
			if (group === undefined || spared.has(group)) continue;
			if (group === own) {
				pids.add(pid);
				table.kill({ pid });
			} else if (!groups.has(group)) {
				groups.add(group);
				table.kill({ group });
			}
		}
	}
	return { groups: [...groups], pids: [...pids] };
}

function markedWhere(
	chosen: (environ: Readonly<Record<string, string>>) => boolean,
	table: ProcessTable,
): number[] {
	return table.pids().filter((pid) => {
		if (pid === table.self) return false;
		const environ = table.environ(pid);
		return environ !== undefined && chosen(environ);
	});
}

/** The process table Linux keeps under /proc. */
export function linuxProcessTable(root = "/proc"): ProcessTable {
	const stat = (pid: number): string | undefined => {
		try {
			return readFileSync(`${root}/${pid}/stat`, "utf8");
		} catch {
			// The process ended between listing and reading.
			return undefined;
		}
	};
	return {
		self: process.pid,
		pids: () =>
			readdirSync(root)
				.filter((name) => /^\d+$/.test(name))
				.map(Number),
		environ: (pid) => {
			try {
				return parseEnviron(readFileSync(`${root}/${pid}/environ`, "utf8"));
			} catch {
				// Gone, or another user's: either way not this conversation's.
				return undefined;
			}
		},
		group: (pid) => {
			const line = stat(pid);
			return line === undefined ? undefined : parseGroup(line);
		},
		started: (pid) => {
			const line = stat(pid);
			return line === undefined ? undefined : parseStarted(line);
		},
		kill: (target) => {
			try {
				process.kill("group" in target ? -target.group : target.pid, "SIGKILL");
			} catch {
				// It ended before the signal: what reaping wanted.
			}
		},
	};
}

/** A /proc environ file's entries, NUL-separated `name=value`. */
export function parseEnviron(text: string): Record<string, string> {
	const entries: Record<string, string> = {};
	for (const entry of text.split("\0")) {
		const at = entry.indexOf("=");
		if (at > 0) entries[entry.slice(0, at)] = entry.slice(at + 1);
	}
	return entries;
}

/** The process group from a /proc stat line, read after the command's parenthesis. */
export function parseGroup(stat: string): number | undefined {
	const group = statField(stat, GROUP_FIELD);
	return group !== undefined && group > 0 ? group : undefined;
}

/** When a process started, in ticks since boot, from a /proc stat line. */
export function parseStarted(stat: string): number | undefined {
	return statField(stat, START_FIELD);
}

/** A whole-number field of a /proc stat line, counted from the field after the command. */
function statField(stat: string, field: number): number | undefined {
	const fields = stat
		.slice(stat.lastIndexOf(")") + 1)
		.trim()
		.split(/\s+/);
	const value = Number(fields.at(field));
	return Number.isInteger(value) && value >= 0 ? value : undefined;
}
