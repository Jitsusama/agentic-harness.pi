/**
 * Finds and ends what a conversation's tools left running.
 *
 * pi starts each bash command as a process group of its own, built from the
 * conversation's environment, and kills that group only when the command is
 * aborted or times out. A stop, or a host killed outright, leaves it running,
 * so the next start would report a tool cut off while it carried on. Each
 * conversation's environment carries a marker naming it, which every child
 * and descendant inherits; reaping finds every process carrying this
 * conversation's marker and kills its group. A reused pid carries no marker,
 * so it is never mistaken for a child. Linux's /proc is the process table.
 */
import { readdirSync, readFileSync } from "node:fs";

/** The variable naming the conversation a process was started for. */
export const CONVERSATION_MARKER = "PI_HOST_CONVERSATION";

/** How many times reaping looks again, for a child forked while it killed. */
const MOST_PASSES = 3;

/** Where the group sits after a stat line's command: state, parent, group. */
const GROUP_FIELD = 2;

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
	/** Kill a whole group, or one process when the group is this one's own. */
	kill(target: { group: number } | { pid: number }): void;
}

/** The environment entries that mark a process as one conversation's. */
export function conversationMarker(sessionId: string): Record<string, string> {
	return { [CONVERSATION_MARKER]: sessionId };
}

/**
 * Kill every process group holding a process this conversation's tools
 * started, answering the groups and lone processes it killed.
 */
export function reapToolChildren(
	sessionId: string,
	table: ProcessTable = linuxProcessTable(),
): { groups: number[]; pids: number[] } {
	const own = table.group(table.self);
	const groups = new Set<number>();
	const pids = new Set<number>();
	for (let pass = 0; pass < MOST_PASSES; pass += 1) {
		const found = marked(sessionId, table);
		if (found.length === 0) break;
		for (const pid of found) {
			const group = table.group(pid);
			if (group === undefined) continue;
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

/** Every process other than this one carrying the conversation's marker. */
export function marked(sessionId: string, table: ProcessTable): number[] {
	return table
		.pids()
		.filter(
			(pid) =>
				pid !== table.self &&
				table.environ(pid)?.[CONVERSATION_MARKER] === sessionId,
		);
}

/** The process table Linux keeps under /proc. */
export function linuxProcessTable(root = "/proc"): ProcessTable {
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
			try {
				return parseGroup(readFileSync(`${root}/${pid}/stat`, "utf8"));
			} catch {
				// The process ended between listing and reading.
				return undefined;
			}
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
	const fields = stat
		.slice(stat.lastIndexOf(")") + 1)
		.trim()
		.split(/\s+/);
	const group = Number(fields[GROUP_FIELD]);
	return Number.isInteger(group) && group > 0 ? group : undefined;
}
