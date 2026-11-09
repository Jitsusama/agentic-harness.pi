/**
 * The spend tool's resource report: the CPU time, disk I/O and memory
 * each quest's sessions used, beside the money they spent.
 *
 * pi's logs say what every turn cost in tokens but nothing about what
 * the machine did, so this is the one figure the cost workflow records
 * rather than derives. Each interactive session writes a line at every
 * turn's end saying what the process used since the line before, in a
 * file named after its session log. Which quest a line belongs to is
 * not recorded here: the report asks the ledger which quest the
 * session's turns were booked to at that moment, so money and machine
 * time are booked by one rule and agree when that rule improves.
 *
 * Only sessions with a person at them record, because a subagent is a
 * child of the session that started it, and its CPU already lands in
 * that session's figure when it ends. In a shared host, every turn end
 * advances one process baseline and writes to the host's file instead.
 * Host CPU and memory cannot honestly be apportioned among conversations.
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { hosted } from "../../lib/core/session/index.ts";
import { processGlobal } from "../../lib/internal/process-global.ts";
import { formatSize } from "../../lib/internal/quest/footprint.ts";
import {
	type Counters,
	NOTHING,
	readCounters,
	type Usage,
	usageBetween,
} from "../../lib/internal/resources.ts";
import { count } from "../../lib/ui/count.ts";

/** One turn's use, as a session's file holds it. */
export interface Sample extends Usage {
	/** When the turn ended, as an ISO time the ledger's timestamps compare with. */
	readonly at: string;
	/**
	 * How many extension loads this process has seen, including hosted
	 * conversation starts and reloads, so memory can be read against loads.
	 * Absent in samples from before 9 November.
	 */
	readonly loads?: number;
	/** Shared-host counters belong to this host, never to a quest. */
	readonly host?: string;
}

/** How many times the harness has loaded in this process. */
const LOADS = "agentic-harness.resources.loads";

/** Count one more load of the harness in this process, as it starts. */
export function noteLoad(): void {
	processGlobal(LOADS, () => ({ count: 0 })).count += 1;
}

/**
 * The last reading, kept for the whole process on `globalThis`: a
 * reload runs new code in the same process, and starting again from
 * nothing would book everything the process ever used to the next turn.
 */
const LAST = Symbol.for("agentic-harness.resources.last-reading");

type Slot = Record<symbol, Counters | undefined>;

/** What a turn's end records with, so a test can stand in. */
export interface SampleDeps {
	readonly dir: string;
	readonly now?: () => Date;
	readonly read?: () => Counters;
}

/**
 * Record what the process used since the last turn's end, in the file
 * for `sessionLog`. The first reading in a process is measured from
 * nothing, which books pi's start to the session it started for.
 * Hosted calls use one host file and the same process baseline, never a
 * session slot: each session sampling from zero would double-count CPU.
 */
export function recordTurn(sessionLog: string, deps: SampleDeps): Sample {
	const slot = globalThis as Slot;
	const host = hosted();
	const reading = (deps.read ?? readCounters)();
	const sample: Sample = {
		at: (deps.now?.() ?? new Date()).toISOString(),
		...usageBetween(slot[LAST] ?? NOTHING, reading),
		loads: processGlobal(LOADS, () => ({ count: 0 })).count,
		...(host ? { host: host.key } : {}),
	};
	slot[LAST] = reading;
	mkdirSync(deps.dir, { recursive: true });
	const name = host
		? `host-${encodeURIComponent(host.key)}-${host.owner.pid}-${encodeURIComponent(String(host.owner.startTicks ?? host.owner.startedAt))}.jsonl`
		: basename(sessionLog);
	appendFileSync(join(deps.dir, name), `${JSON.stringify(sample)}\n`);
	return sample;
}

/** Forget the last reading, as a fresh process would. Tests use it. */
export function forgetLastReading(): void {
	delete (globalThis as Slot)[LAST];
}

/** Whether a parsed line is a sample this version can read. */
function isSample(data: unknown): data is Sample {
	if (typeof data !== "object" || data === null) return false;
	const s = data as Record<string, unknown>;
	const figure = (v: unknown) => v === null || typeof v === "number";
	return (
		(s.host === undefined || typeof s.host === "string") &&
		typeof s.at === "string" &&
		typeof s.cpuSelfMs === "number" &&
		typeof s.rssBytes === "number" &&
		figure(s.cpuChildrenMs) &&
		figure(s.readBytes) &&
		figure(s.writeBytes)
	);
}

/** Every session's samples under `dir`, by session log name. */
export function readSamples(dir: string): Map<string, Sample[]> {
	const found = new Map<string, Sample[]>();
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return found;
	}
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		let text: string;
		try {
			text = readFileSync(join(dir, name), "utf8");
		} catch {
			continue;
		}
		const samples: Sample[] = [];
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (isSample(parsed)) samples.push(parsed);
			} catch {
				// A line cut short by a crash says nothing; the rest still do.
			}
		}
		if (samples.length > 0) found.set(name, samples);
	}
	return found;
}

/** The moment a session's turns started being booked to `quest`. */
export interface QuestChange {
	readonly session: string;
	readonly at: string;
	readonly quest: string | null;
}

/**
 * The ledger query for the turns where each session's quest changed,
 * which is a handful of rows per session however many turns it ran.
 */
export function questChangesQuery(sessions: readonly string[]): string {
	const names = sessions.map((s) => `'${s.replaceAll("'", "''")}'`).join(", ");
	return [
		"SELECT session_id, timestamp, quest FROM (",
		"  SELECT session_id, timestamp, quest,",
		"    LAG(quest) OVER (PARTITION BY session_id ORDER BY timestamp) AS before,",
		"    ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp) AS n",
		`  FROM turn_facts WHERE session_id IN (${names})`,
		") WHERE n = 1 OR before IS NOT quest",
		"ORDER BY session_id, timestamp",
	].join("\n");
}

/** What one quest's sessions used. */
export interface QuestUse {
	readonly quest: string | null;
	/** A process-level row, deliberately not apportioned among quests. */
	readonly host?: string;
	turns: number;
	cpuSelfMs: number;
	cpuChildrenMs: number;
	readBytes: number;
	writeBytes: number;
	peakRssBytes: number;
	/** Whether any of it came from a process that could not count children. */
	partial: boolean;
}

/** The quest in force at `at`: the last change at or before it, else the first. */
function questAt(changes: readonly QuestChange[], at: string): string | null {
	let found = changes[0]?.quest ?? null;
	for (const change of changes) {
		if (change.at > at) break;
		found = change.quest;
	}
	return found;
}

/** Book every sample to its quest, heaviest CPU first. */
export function useByQuest(
	samples: ReadonlyMap<string, readonly Sample[]>,
	changes: readonly QuestChange[],
): QuestUse[] {
	const bySession = new Map<string, QuestChange[]>();
	for (const change of changes) {
		const list = bySession.get(change.session) ?? [];
		list.push(change);
		bySession.set(change.session, list);
	}
	const uses = new Map<string, QuestUse>();
	for (const [session, list] of samples) {
		const sessionChanges = bySession.get(session) ?? [];
		for (const sample of list) {
			const quest =
				sample.host !== undefined ? null : questAt(sessionChanges, sample.at);
			const key = JSON.stringify(
				sample.host !== undefined ? ["host", sample.host] : ["quest", quest],
			);
			let use = uses.get(key);
			if (!use) {
				use = {
					quest,
					...(sample.host !== undefined ? { host: sample.host } : {}),
					turns: 0,
					cpuSelfMs: 0,
					cpuChildrenMs: 0,
					readBytes: 0,
					writeBytes: 0,
					peakRssBytes: 0,
					partial: false,
				};
				uses.set(key, use);
			}
			use.turns += 1;
			use.cpuSelfMs += sample.cpuSelfMs;
			use.cpuChildrenMs += sample.cpuChildrenMs ?? 0;
			use.readBytes += sample.readBytes ?? 0;
			use.writeBytes += sample.writeBytes ?? 0;
			use.peakRssBytes = Math.max(use.peakRssBytes, sample.rssBytes);
			if (sample.cpuChildrenMs === null) use.partial = true;
		}
	}
	const cpu = (u: QuestUse) => u.cpuSelfMs + u.cpuChildrenMs;
	return [...uses.values()].sort((a, b) => cpu(b) - cpu(a));
}

/** CPU time, in the largest unit that reads as more than one. */
export function formatCpu(ms: number): string {
	if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)} CPU hours`;
	if (ms >= 60_000) return `${Math.round(ms / 60_000)} CPU minutes`;
	return `${Math.round(ms / 1000)} CPU seconds`;
}

const bytes = (n: number) => formatSize({ bytes: n, complete: true });

/** One quest's line. */
function useLine(use: QuestUse): string {
	const name =
		use.host !== undefined ? `Host ${use.host}` : (use.quest ?? "No quest");
	const own = formatCpu(use.cpuSelfMs).replace(/ CPU /, " ");
	const ran = formatCpu(use.cpuChildrenMs).replace(/ CPU /, " ");
	return (
		`- ${name}: ${formatCpu(use.cpuSelfMs + use.cpuChildrenMs)} ` +
		`(pi ${own}, what it ran ${ran}), read ${bytes(use.readBytes)}, ` +
		`wrote ${bytes(use.writeBytes)}, pi held up to ${bytes(use.peakRssBytes)}, ` +
		`over ${count(use.turns, use.host !== undefined ? "sample" : "turn")}` +
		(use.partial ? "; pi alone on some, where children are not counted" : "")
	);
}

/** The report. */
export function formatUse(
	uses: readonly QuestUse[],
	since: string | undefined,
	limit: number,
): string {
	if (uses.length === 0 || since === undefined) {
		return (
			"No resource figures yet. Each session with a person at it records " +
			"its CPU time, disk I/O and memory at the end of every turn from now on."
		);
	}
	const total = (pick: (u: QuestUse) => number) =>
		uses.reduce((sum, u) => sum + pick(u), 0);
	const own = total((u) => u.cpuSelfMs);
	const ran = total((u) => u.cpuChildrenMs);
	const hasHosts = uses.some((use) => use.host !== undefined);
	const lines = [
		`Since ${since.slice(0, 10)}, ${hasHosts ? "sessions and hosts" : "sessions"} used ${formatCpu(own + ran)}: ` +
			`${formatCpu(own)} in pi itself and ${formatCpu(ran)} in the commands ` +
			`and subagents it ran. They read ${bytes(total((u) => u.readBytes))} ` +
			`from disk and wrote ${bytes(total((u) => u.writeBytes))}.`,
		"",
		hasHosts
			? "By quest and host, heaviest CPU first:"
			: "By quest, heaviest CPU first:",
		...uses.slice(0, limit).map(useLine),
	];
	if (uses.length > limit) {
		lines.push(`And ${uses.length - limit} more; ask for a larger limit.`);
	}
	lines.push(
		"",
		"Not counted: work a daemon does for pi (a nix build runs in " +
			"nix-daemon), and a command still running, which counts when it " +
			"ends. A quest is the one the ledger booked the session's turns to.",
	);
	if (hasHosts)
		lines.push(
			"Shared-host counters are process totals, not per-conversation use; each host has one baseline. Loads include conversation starts and reloads.",
		);
	return lines.join("\n");
}

/** The earliest sample's time, which is how far back the figures reach. */
export function earliest(
	samples: ReadonlyMap<string, readonly Sample[]>,
): string | undefined {
	let first: string | undefined;
	for (const list of samples.values()) {
		for (const sample of list) {
			if (first === undefined || sample.at < first) first = sample.at;
		}
	}
	return first;
}
