/**
 * Kept calls nothing will ever take up or end, found and ended.
 *
 * A kept call's processes outlive its pi on purpose, so a move or a
 * restart can carry them (kept.ts). One whose pi went with nothing
 * recorded, no `.job` and no `.carried`, was never anyone's to take up:
 * no conversation reports it, no host's look stops it, and the week's
 * sweep removes only its files. On 28 November four kept `tee` scopes sat
 * in jobs.slice 8 to 65 hours, parented by the user manager, with no
 * record left of any of them (A210E4CA's finding).
 *
 * They are found by the record, never by a command line: each process
 * of a kept call's stub, its `tee` among them, carries the call's path in
 * `PI_BASH_KEEP`, which only an environment this account can read shows,
 * so another account's process is never matched. Only a path directly in
 * the kept folder counts. A call is ended when it has no record, no carry
 * and its `.owner` names a pi that has gone, or when its files are gone
 * altogether; one from before `.owner` was written is ended only once its
 * shell has gone, since only then is it proved that nothing runs it. A
 * call whose owner can't be read for the moment is left to the next look.
 *
 * Ending one kills each of its kept processes, its shell's whole group
 * while the shell still leads one, and, when the call never said how it
 * ended, every process its mark names (reap.ts), as a stop does
 * (carried.ts). One that ended by itself keeps what it left running, as
 * any command's does; only its `tee` goes.
 */

import { readdirSync, readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { processGlobal } from "../process/process-global.ts";
import { provedCall } from "./carried.ts";
import {
	CARRIED_SUFFIX,
	JOB_SUFFIX,
	KEEP_VARIABLE,
	keptFolder,
	OWNER_SUFFIX,
	ownerRuns,
	SWEEP_EVERY_MS,
} from "./kept.ts";
import { removeKept } from "./kept-removal.ts";
import { CALL_VARIABLE, reap } from "./reap.ts";

/** The processes the orphans are looked for among, for tests to stand in for. */
export interface KeptProcesses {
	/** This process's own id, never ended. */
	readonly self: number;
	pids(): readonly number[];
	/** A process's environment, or nothing once it is gone or not this account's. */
	environ(
		pid: number,
		mentioning?: string,
	): Promise<Readonly<Record<string, string>> | undefined>;
	/** A process's group, or nothing once it is gone. */
	group(pid: number): number | undefined;
	/** Kill a whole group, or one process. */
	kill(target: { group: number } | { pid: number }): void;
}

/** What a look for orphans needs, for tests to stand in for. */
export interface OrphanOptions {
	/** The kept folder; kept.ts's by default. */
	readonly folder?: string;
	readonly table?: KeptProcesses;
	/** Whether the pi an owner mark names still runs; kept.ts's by default. */
	readonly ownerRuns?: (mark: string) => boolean;
	/** Whether a pid is the call a mark names; carried.ts's by default. */
	readonly proved?: (pid: number, mark: string) => boolean;
	/** Kill every process a call's mark names; reap.ts's by default. */
	readonly reap?: (mark: string) => void;
	readonly say?: (line: string) => void;
}

/** One kept call this look ended, and why. */
export interface EndedOrphan {
	readonly keep: string;
	readonly pids: readonly number[];
	readonly why: string;
}

/** How a file of a call reads: its text, gone, or not readable for the moment. */
type Read = { text: string } | "gone" | "unknown";

/**
 * End every kept call whose processes still run but that nothing holds,
 * saying a line for each. Answers what it ended.
 */
export async function endOrphanedKept(
	options: OrphanOptions = {},
): Promise<EndedOrphan[]> {
	const folder = resolve(options.folder ?? keptFolder());
	const table = options.table ?? procTable();
	const runs = options.ownerRuns ?? ((mark: string) => ownerRuns(mark));
	const proved = options.proved ?? provedCall;
	const reapMark = options.reap ?? reap;
	const kept = await keptProcesses(folder, table);
	const ended: EndedOrphan[] = [];
	for (const [keep, found] of kept) {
		const why = await orphaned(keep, found.mark, runs, proved);
		if (why === undefined) continue;
		const pids = [...found.pids];
		for (const pid of pids) {
			// The shell leads its own group while it runs: the whole of it goes.
			if (table.group(pid) === pid && pid !== table.self)
				table.kill({ group: pid });
			table.kill({ pid });
		}
		if (found.mark !== undefined && !(await endSaid(keep)))
			reapMark(found.mark);
		void removeKept(keep);
		ended.push({ keep, pids, why });
		options.say?.(
			`Ended kept call ${basename(keep)} (${pids.length === 1 ? "pid" : "pids"} ${pids.join(", ")}): ${why}`,
		);
	}
	return ended;
}

// When each folder was last looked over, for the whole process and every
// copy of this module, as the kept folder's sweep is (kept.ts).
const lookedAt = processGlobal(
	"agentic-harness.internal/shell/kept-orphans-looked-at.v1",
	() => new Map<string, number>(),
);

/**
 * Look for orphans in `folder` as {@link endOrphanedKept} does, unless
 * this process began a look there within the hour: a plain pi, which no
 * host looks after, ends what an earlier pi left so.
 */
export function endOrphanedKeptNowAndThen(
	folder: string = keptFolder(),
	now: number = Date.now(),
): Promise<EndedOrphan[]> {
	const last = lookedAt.get(folder);
	if (last !== undefined && now >= last && now - last < SWEEP_EVERY_MS)
		return Promise.resolve([]);
	lookedAt.set(folder, now);
	return endOrphanedKept({ folder });
}

/** Each kept call's processes, by its path, with the mark they carry. */
async function keptProcesses(
	folder: string,
	table: KeptProcesses,
): Promise<Map<string, { pids: number[]; mark?: string }>> {
	const kept = new Map<string, { pids: number[]; mark?: string }>();
	const mentioning = `${KEEP_VARIABLE}=${folder}/`;
	for (const pid of table.pids()) {
		if (pid === table.self) continue;
		const environ = await table.environ(pid, mentioning);
		const keep = environ?.[KEEP_VARIABLE];
		// Only a call's own path in this folder: never a folder below it,
		// nor one named some other way.
		if (keep === undefined || dirname(keep) !== folder) continue;
		const found = kept.get(keep) ?? { pids: [] };
		found.pids.push(pid);
		const mark = environ?.[CALL_VARIABLE];
		if (mark !== undefined && found.mark === undefined) found.mark = mark;
		kept.set(keep, found);
	}
	return kept;
}

/** Why the call at `keep` is nobody's, or nothing while something holds it. */
async function orphaned(
	keep: string,
	mark: string | undefined,
	runs: (mark: string) => boolean,
	proved: (pid: number, mark: string) => boolean,
): Promise<string | undefined> {
	// A record is left to the conversation that takes it up, and to the
	// host whose look stops it once nobody does; a carry to whoever holds it.
	if (await there(`${keep}${JOB_SUFFIX}`)) return undefined;
	if (await there(`${keep}${CARRIED_SUFFIX}`)) return undefined;
	const owner = await read(`${keep}${OWNER_SUFFIX}`);
	if (owner === "unknown") return undefined;
	if (owner !== "gone")
		return runs(owner.text)
			? undefined
			: "the pi that started it has gone and nothing recorded it";
	const pid = await read(`${keep}.pid`);
	if (pid === "unknown") return undefined;
	if (pid === "gone")
		return (await read(`${keep}.out`)) === "gone"
			? "its files are gone, so nothing holds it"
			: undefined;
	// Written before pi named a call's owner: proved nobody's only once its
	// shell has gone.
	const shell = wholeNumber(pid.text);
	// Its stub hasn't said its shell yet: not proved gone.
	if (shell === undefined) return undefined;
	if (mark !== undefined && proved(shell, mark)) return undefined;
	return "its shell has gone and nothing recorded it";
}

/**
 * Whether the call at `keep` wrote how it ended; true too when that can't
 * be read for the moment, so nothing it left is reaped on a guess.
 */
async function endSaid(keep: string): Promise<boolean> {
	const end = await read(`${keep}.end`);
	if (end === "unknown") return true;
	return end !== "gone" && wholeNumber(end.text) !== undefined;
}

/** The whole number `text` holds, or nothing. */
function wholeNumber(text: string): number | undefined {
	return /^\d+\n?$/.test(text) ? Number(text.trim()) : undefined;
}

/** Whether `file` is there; true too when that can't be said for the moment. */
async function there(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch (error) {
		return !isGone(error);
	}
}

async function read(file: string): Promise<Read> {
	try {
		return { text: await readFile(file, "utf8") };
	} catch (error) {
		return isGone(error) ? "gone" : "unknown";
	}
}

function isGone(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

/** This account's processes as /proc shows them; none off Linux. */
function procTable(root = "/proc"): KeptProcesses {
	return {
		self: process.pid,
		pids: () => {
			try {
				return readdirNumbers(root);
			} catch {
				// No /proc, as off Linux: no process to look at.
				return [];
			}
		},
		environ: async (pid, mentioning) => {
			let bytes: Buffer;
			try {
				bytes = await readFile(`${root}/${pid}/environ`);
			} catch {
				// Gone, or another account's: either way never ours to end.
				return undefined;
			}
			if (mentioning !== undefined && !bytes.includes(mentioning))
				return undefined;
			const entries: Record<string, string> = {};
			for (const entry of bytes.toString("utf8").split("\0")) {
				const at = entry.indexOf("=");
				if (at > 0) entries[entry.slice(0, at)] = entry.slice(at + 1);
			}
			return entries;
		},
		group: (pid) => {
			let stat: string;
			try {
				stat = readFileSync(`${root}/${pid}/stat`, "utf8");
			} catch {
				// Gone between listing and reading.
				return undefined;
			}
			// The group is the third field after the command's parenthesis.
			const group = Number(
				stat
					.slice(stat.lastIndexOf(")") + 1)
					.trim()
					.split(/\s+/)[2],
			);
			return Number.isInteger(group) && group > 1 ? group : undefined;
		},
		kill: (target) => {
			try {
				process.kill("group" in target ? -target.group : target.pid, "SIGKILL");
			} catch {
				// It ended before the signal: what the look wanted.
			}
		},
	};
}

function readdirNumbers(root: string): number[] {
	return readdirSync(root)
		.filter((name) => /^\d+$/.test(name))
		.map(Number);
}
