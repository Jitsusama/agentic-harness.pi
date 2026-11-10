/**
 * Learning sensor.
 *
 * Counts what keeps going wrong in the pi session logs, so each
 * recurring mistake can become a proposed harness change and the
 * same count can show whether the change made it recur less. Five
 * kinds of signal, each counted as distinct sessions per ISO week, or
 * per day for a daily measure:
 *
 * - refusal: a harness tool answered `⊘`, refusing the call. The
 *   refusal's first line is the group, and each `- ` bullet under it
 *   (a PR section over its word limit, say) is a reason of its own.
 * - guard: a call a harness guard refused: a shell command a blocking
 *   guard stopped (`Blocked:`, `Quest workflow:`, `History guard:`),
 *   or any call a redirecting guard turned back, known by the override
 *   hint its refusal ends with. Ordinary command failures are left
 *   out; a failing grep is not a mistake.
 * - override: a redirect the agent made again unchanged, so it went
 *   through, read from the guard report the policy stores for it.
 * - habit: a tool call that breaks a standing rule no guard catches,
 *   such as adding nice or reading a whole plan. Shell commands are
 *   read with their heredoc bodies cut, so a script inside one is not
 *   read as the command itself.
 * - context: a context grown large: a turn that read 400k tokens or
 *   more, and a compaction a run overtook, from the entry the
 *   compaction trigger leaves. Its calls are turns and stalls, so it
 *   counts how much as well as how many sessions.
 *
 * Refusals, guards and overrides are exact, since the logs mark them.
 * A habit a guard catches is counted by the guard, never guessed again
 * from the command: a pattern can't tell a tracked file from scratch,
 * and once counted 2,368 shell edits in a week, nearly all of them of
 * scratch or untracked files the guard rightly let be.
 * Habits are patterns, tuned for precision over recall: a trend that
 * bends is the goal, not a census. Each period also says how many
 * sessions were active in it, so a quiet day reads as a rate, not a
 * drop. A habit an interceptor fixes silently, such as build output
 * cut with tail, costs nothing and is not counted.
 *
 * A log last written before the window opened is not read at all, so
 * a day's count reads a day's logs rather than every log since March.
 * A session whose log the backup has removed from the machine is read
 * back from Drive, through session-backup's index, and the copy removed
 * once read; `--here` reads only the machine's logs, for a quick look,
 * since each copy takes a second or two.
 *
 * Run it directly (Node strips the types):
 *
 *   node scripts/learning-sensor.ts [--since YYYY-MM-DD] [--by day]
 *     [--top N] [--json <file>] [--here]
 *
 * See the convention-recurrence-sensor-guide skill for the method
 * and how the output feeds proposals.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { Span } from "../extensions/spend-workflow/audit.ts";
import { STALLED_ENTRY } from "../lib/compaction/failure.ts";
import {
	GUARD_REPORT_ENTRY,
	isGuardReport,
	OVERRIDE_HINT,
} from "../lib/guardian/report.ts";
import { sessionsDir } from "../lib/internal/paths.ts";
import { isRecord } from "../lib/internal/record.ts";
import {
	backupIndexPath,
	type FetchLog,
	readAway,
	sessionLogs,
} from "../lib/internal/session-logs.ts";
import { isoWeek } from "./convention-recurrence.ts";

/** What kind of thing went wrong. */
export type SignalKind =
	| "refusal"
	| "reason"
	| "guard"
	| "override"
	| "habit"
	| "context";

/** One thing that went wrong, as it groups with others like it. */
export interface Signal {
	readonly kind: SignalKind;
	readonly key: string;
	/** The text it was read from, cut short, for a reader to check. */
	readonly sample: string;
}

/** A tool call as the logs keep it. */
export interface ToolCall {
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

/** A habit that breaks a standing rule, and how a call shows it. */
interface Habit {
	readonly key: string;
	readonly test: (call: ToolCall, command: string) => boolean;
}

const QUEST_DOCUMENT =
	/quest-workflow\/quests\/[^\s'"]*\/(plans|research|briefs|reports)\//;

/**
 * The habits counted, each named by the rule it breaks. A shell edit
 * of a tracked file, a long sleep and git stash are not here: their
 * guards refuse them, so the guard and override rows count them.
 */
export const HABITS: readonly Habit[] = [
	{
		key: "nice or ionice added",
		test: (_, c) => /(^|[;&|]\s*)(nice\s+(-n\s*)?-?\d|ionice\s+-c)/.test(c),
	},
	{
		key: "git worktree run by hand",
		test: (_, c) => /\bgit\s+worktree\s+(add|remove|prune)\b/.test(c),
	},
	{
		key: "quest document read whole",
		test: (call) =>
			call.name === "read" &&
			QUEST_DOCUMENT.test(String(call.arguments.path ?? "")) &&
			call.arguments.offset == null &&
			call.arguments.limit == null,
	},
	{
		key: "quest document searched from the shell",
		test: (_, c) => /\b(grep|sed|awk)\b/.test(c) && QUEST_DOCUMENT.test(c),
	},
];

const GUARD_LINE = /^(Blocked|Quest workflow|History guard)\b/;

/** A shell command with its heredoc bodies cut out. */
export function withoutHeredocs(command: string): string {
	return command.replace(
		/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g,
		"",
	);
}

/**
 * A line of tool text as a group key: paths, ids, numbers and quoted
 * text folded, so two refusals of one kind read the same.
 */
export function normalise(line: string): string {
	return line
		.trim()
		.replace(/(~|\.{0,2})?\/[\w.@~+-]+(\/[\w.@~+-]+)+\/?/g, "<path>")
		.replace(/\b[0-9a-f]{7,40}\b/g, "#")
		.replace(/\b[A-Z0-9]{6}\b/g, "#")
		.replace(/\d+/g, "#")
		.replace(/`[^`]*`/g, "`x`")
		.replace(/"[^"]*"/g, '"x"')
		.slice(0, 100);
}

/** The signals a tool's answer carries. */
export function signalsFromResult(
	toolName: string,
	text: string,
	isError: boolean,
): Signal[] {
	const trimmed = text.trim();
	const sample = trimmed.slice(0, 300);
	if (trimmed.startsWith("⊘")) {
		const [first, ...rest] = trimmed.slice(1).split("\n");
		const signals: Signal[] = [
			{ kind: "refusal", key: `${toolName}: ${normalise(first)}`, sample },
		];
		for (const line of rest) {
			if (/^\s*- /.test(line)) {
				signals.push({
					kind: "reason",
					key: `${toolName}: ${normalise(line.replace(/^\s*- /, ""))}`,
					sample: line.trim().slice(0, 300),
				});
			}
		}
		return signals;
	}
	if (
		trimmed.endsWith(OVERRIDE_HINT) ||
		(isError && toolName === "bash" && GUARD_LINE.test(trimmed))
	) {
		return [{ kind: "guard", key: normalise(trimmed.split("\n")[0]), sample }];
	}
	return [];
}

/**
 * The signal a stored session entry carries: a redirect made again
 * unchanged, which the guard let through and reported. Every other
 * entry, and every other kind of report, carries none.
 */
export function signalsFromEntry(entry: {
	readonly customType?: unknown;
	readonly data?: unknown;
}): Signal[] {
	if (entry.customType === STALLED_ENTRY) {
		return [
			{
				kind: "context",
				key: STALLED_KEY,
				sample: JSON.stringify(entry.data ?? {}).slice(0, 300),
			},
		];
	}
	if (entry.customType !== GUARD_REPORT_ENTRY) return [];
	const report = entry.data;
	if (!isGuardReport(report) || report.kind !== "overridden") return [];
	return [
		{
			kind: "override",
			key: `${report.guard}: ${report.title}`,
			sample: (report.body ?? "").slice(0, 300),
		},
	];
}

/**
 * A turn this large reads a context compaction should have cut: on 9
 * November 3,599 turns in 148 sessions read 400k or more, most behind
 * compactions that waited hours, against 170k to 260k a turn as usual.
 */
export const LARGE_TURN_TOKENS = 400_000;

const LARGE_TURN_KEY = "A turn reading 400k tokens or more";
const STALLED_KEY = "A compaction a run overtook";

function tokens(value: unknown): number {
	return typeof value === "number" ? value : 0;
}

/** The signal an assistant turn's usage carries: a context grown large. */
export function signalsFromTurn(usage: unknown): Signal[] {
	if (!isRecord(usage)) return [];
	const read =
		tokens(usage.input) + tokens(usage.cacheRead) + tokens(usage.cacheWrite);
	if (read < LARGE_TURN_TOKENS) return [];
	return [
		{
			kind: "context",
			key: LARGE_TURN_KEY,
			sample: `${read.toLocaleString("en-CA")} tokens`,
		},
	];
}

/** The habits a tool call shows. */
export function signalsFromCall(call: ToolCall): Signal[] {
	const command =
		call.name === "bash"
			? withoutHeredocs(String(call.arguments.command ?? ""))
			: "";
	const sample = JSON.stringify(call.arguments).slice(0, 300);
	return HABITS.filter((habit) => habit.test(call, command)).map((habit) => ({
		kind: "habit",
		key: habit.key,
		sample,
	}));
}

/** The period a moment falls in: `2026-W44`, or `2026-10-26`. */
export function periodOf(when: number, by: Span): string {
	return by === "day"
		? new Date(when).toISOString().slice(0, 10)
		: isoWeek(when);
}

/** A signal seen in one session in one period. */
export interface Sighting extends Signal {
	readonly period: string;
	readonly session: string;
}

/** Signals of one kind and key, counted by distinct sessions. */
export interface Group {
	readonly kind: SignalKind;
	readonly key: string;
	readonly calls: number;
	readonly sessions: number;
	/** Distinct sessions per period. */
	readonly periods: Readonly<Record<string, number>>;
	readonly samples: readonly string[];
}

const SAMPLES = 3;

/** Group sightings, most sessions first. */
export function tally(sightings: readonly Sighting[]): Group[] {
	const groups = new Map<
		string,
		{
			kind: SignalKind;
			key: string;
			calls: number;
			sessions: Set<string>;
			periods: Map<string, Set<string>>;
			samples: string[];
		}
	>();
	for (const s of sightings) {
		const id = `${s.kind}\u0000${s.key}`;
		let group = groups.get(id);
		if (!group) {
			group = {
				kind: s.kind,
				key: s.key,
				calls: 0,
				sessions: new Set(),
				periods: new Map(),
				samples: [],
			};
			groups.set(id, group);
		}
		group.calls++;
		group.sessions.add(s.session);
		const period = group.periods.get(s.period) ?? new Set<string>();
		period.add(s.session);
		group.periods.set(s.period, period);
		if (group.samples.length < SAMPLES) group.samples.push(s.sample);
	}
	return [...groups.values()]
		.map((g) => ({
			kind: g.kind,
			key: g.key,
			calls: g.calls,
			sessions: g.sessions.size,
			periods: Object.fromEntries(
				[...g.periods].map(([period, sessions]) => [period, sessions.size]),
			),
			samples: g.samples,
		}))
		.sort((a, b) => b.sessions - a.sessions || b.calls - a.calls);
}

const HEADINGS: Record<SignalKind, string> = {
	habit: "Habits",
	refusal: "Refusals",
	reason: "Reasons Given in Refusals",
	guard: "Calls Guards Refused",
	override: "Refusals Made Again, Which Went Through",
	context: "Context Grown Large",
};

/**
 * A markdown report: sessions active per period, then each kind's top
 * groups with distinct sessions per period.
 */
export function renderReport(
	groups: readonly Group[],
	active: Readonly<Record<string, number>>,
	options: { since: string; top: number },
): string {
	const periods = Object.keys(active).sort();
	const lines = [
		`# Learning Sensor, Since ${options.since}`,
		"",
		`Sessions active: ${periods.map((p) => `${p} ${active[p]}`).join(", ")}.`,
	];
	for (const kind of [
		"habit",
		"refusal",
		"reason",
		"guard",
		"override",
		"context",
	] as const) {
		const rows = groups.filter((g) => g.kind === kind).slice(0, options.top);
		if (rows.length === 0) continue;
		lines.push(
			"",
			`## ${HEADINGS[kind]}`,
			"",
			`| Sessions | Calls | ${periods.join(" | ")} | What |`,
			`| ---: | ---: | ${periods.map(() => "---:").join(" | ")} | --- |`,
		);
		for (const g of rows) {
			const cells = periods.map((p) => String(g.periods[p] ?? 0));
			const what = g.key.replace(/\|/g, "\\|");
			lines.push(
				`| ${g.sessions} | ${g.calls} | ${cells.join(" | ")} | ${what} |`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

// ── Runner ──────────────────────────────────────────────────

interface LogEntry {
	type?: unknown;
	timestamp?: unknown;
	customType?: unknown;
	data?: unknown;
	message?: {
		role?: unknown;
		toolName?: unknown;
		isError?: unknown;
		content?: unknown;
		usage?: unknown;
	};
}

function textOf(content: unknown): string {
	if (!Array.isArray(content))
		return typeof content === "string" ? content : "";
	return content
		.map((c) =>
			c && typeof c === "object" && "text" in c ? String(c.text) : "",
		)
		.join("\n");
}

function callsOf(content: unknown): ToolCall[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((c) =>
		c && typeof c === "object" && c.type === "toolCall"
			? [
					{
						name: String(c.name),
						arguments: (c.arguments ?? {}) as Record<string, unknown>,
					},
				]
			: [],
	);
}

/**
 * Read one session file: its sightings and the periods it was active.
 * `session` names it, its file name unless it was read back from Drive.
 */
function scanSession(
	path: string,
	sinceMs: number,
	by: Span,
	session = basename(path),
): { sightings: Sighting[]; periods: Set<string> } {
	const sightings: Sighting[] = [];
	const periods = new Set<string>();
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		// Removed since it was listed: nothing to read.
		return { sightings, periods };
	}
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: LogEntry;
		try {
			entry = JSON.parse(line);
		} catch {
			// A live session's torn last line.
			continue;
		}
		const custom = entry.type === "custom";
		if (!custom && (entry.type !== "message" || !entry.message)) continue;
		const when = Date.parse(String(entry.timestamp));
		if (Number.isNaN(when) || when < sinceMs) continue;
		const period = periodOf(when, by);
		if (custom) {
			for (const s of signalsFromEntry(entry))
				sightings.push({ ...s, period, session });
			continue;
		}
		periods.add(period);
		const m = entry.message ?? {};
		const signals =
			m.role === "toolResult"
				? signalsFromResult(
						String(m.toolName),
						textOf(m.content),
						m.isError === true,
					)
				: m.role === "assistant"
					? [
							...signalsFromTurn(m.usage),
							...callsOf(m.content).flatMap(signalsFromCall),
						]
					: [];
		for (const s of signals) sightings.push({ ...s, period, session });
	}
	return { sightings, periods };
}

/** Where `sense` reads, and how it reads a log on Drive only back. */
export interface Sources {
	readonly sessionsDir: string;
	readonly indexPath: string;
	/** Leave the logs on Drive only unread, for a quick look. */
	readonly hereOnly?: boolean;
	readonly fetch?: FetchLog;
}

/**
 * Read every session log from `sinceMs` on, those on Drive only read
 * back unless `hereOnly`: what recurred, grouped, how many sessions were
 * active each period, ISO week unless `by` says day, and how many logs on
 * Drive only couldn't be read back, and why.
 */
export function sense(
	sinceMs: number,
	by: Span = "week",
	sources: Sources = {
		sessionsDir: sessionsDir(),
		indexPath: backupIndexPath(),
	},
): {
	groups: Group[];
	active: Record<string, number>;
	read: { here: number; away: number; unread: number; why?: string };
} {
	const since = Number.isNaN(sinceMs) ? 0 : sinceMs;
	const sightings: Sighting[] = [];
	const active = new Map<string, number>();
	const logs = sessionLogs(since, sources);
	const scans = logs.here.map((file) => scanSession(file, since, by));
	const away = readAway(
		sources.hereOnly ? [] : logs.away,
		(path, log) => scanSession(path, since, by, log.name),
		sources.fetch,
	);
	for (const scanned of [...scans, ...away.read]) {
		sightings.push(...scanned.sightings);
		for (const period of scanned.periods)
			active.set(period, (active.get(period) ?? 0) + 1);
	}
	const read = {
		here: scans.length,
		away: away.read.length,
		unread: sources.hereOnly ? logs.away.length : away.unread,
	};
	return {
		groups: tally(sightings),
		active: Object.fromEntries(active),
		read: away.why === undefined ? read : { ...read, why: away.why },
	};
}

/** What a run read, for the person watching it. */
export function readLine(read: {
	here: number;
	away: number;
	unread: number;
	why?: string;
}): string {
	const said = `read ${read.here} logs on the machine and ${read.away} read back from Drive`;
	if (read.unread === 0) return said;
	return `${said}; ${read.unread} on Drive only went unread${read.why ? `: ${read.why}` : ""}`;
}

function main(): void {
	const args = process.argv.slice(2);
	const option = (name: string) => {
		const index = args.indexOf(name);
		return index >= 0 ? args[index + 1] : undefined;
	};
	const since = option("--since") ?? "1970-01-01";
	const top = Number(option("--top") ?? 20);
	const by: Span = option("--by") === "day" ? "day" : "week";
	const { groups, active, read } = sense(Date.parse(since), by, {
		sessionsDir: sessionsDir(),
		indexPath: backupIndexPath(),
		hereOnly: args.includes("--here"),
	});
	process.stdout.write(renderReport(groups, active, { since, top }));
	process.stderr.write(`${readLine(read)}\n`);
	const json = option("--json");
	if (json) writeFileSync(json, `${JSON.stringify(groups, null, 1)}\n`);
}

if (import.meta.main) {
	main();
}
