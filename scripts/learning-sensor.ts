/**
 * Learning sensor.
 *
 * Counts what keeps going wrong in the pi session logs, so each
 * recurring mistake can become a proposed harness change and the
 * same count can show whether the change made it recur less. Three
 * kinds of signal, each counted as distinct sessions per ISO week:
 *
 * - refusal: a harness tool answered `⊘`, refusing the call. The
 *   refusal's first line is the group, and each `- ` bullet under it
 *   (a PR section over its word limit, say) is a reason of its own.
 * - guard: a shell command a harness guard blocked (`Blocked:`,
 *   `Quest workflow:`, `History guard:`). Ordinary command failures
 *   are left out; a failing grep is not a mistake.
 * - habit: a tool call that breaks a standing rule of the harness,
 *   such as editing a tracked file with sed or waiting with sleep.
 *   Shell commands are read with their heredoc bodies cut, so a
 *   script inside one is not read as the command itself.
 *
 * Refusals and guards are exact, since the logs mark them. Habits
 * are patterns, tuned for precision over recall: a trend that bends
 * is the goal, not a census. Each week also says how many sessions
 * were active in it, so a short week reads as a rate, not a drop.
 *
 * Run it directly (Node strips the types):
 *
 *   node scripts/learning-sensor.ts [--since YYYY-MM-DD] [--top N]
 *     [--json <file>]
 *
 * See the convention-recurrence-sensor-guide skill for the method
 * and how the output feeds proposals.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { isoWeek } from "./convention-recurrence.ts";

/** What kind of thing went wrong. */
export type SignalKind = "refusal" | "reason" | "guard" | "habit";

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
const BUILD_OUTPUT_CUT =
	/\b(vitest|pnpm\s+(test|lint|typecheck|exec)|npm\s+test|cargo\s+(test|build|clippy)|nix\s+(build|flake\s+check)|go\s+test|make)\b[^;\n]*\|\s*(tail|head)\b/;
// An in-place sed or perl, its script, then a file outside scratch.
const IN_PLACE_EDIT =
	/\b(sed\s+(-[a-zA-Z]*i\S*|--in-place)|perl\s+-[a-zA-Z]*i\S*(\s+-e)?)\s+('[^']*'|"[^"]*"|[^\s-]\S*)\s+(?!["']?(\/tmp|\$TMPDIR|~\/\.cache))\S/;
// Text appended or written into a source file outside scratch.
const REDIRECT_EDIT =
	/\b(cat|printf|echo)\b[^|;&\n]*>>?\s*(?!\/tmp|\$TMPDIR|~\/\.cache)[^\s;|&]+\.(ts|md|nix|rs)\b/;
// A command run in scratch space edits nothing tracked.
const IN_SCRATCH = /(^|[;&|]\s*)cd\s+("?\$TMPDIR|\/tmp|~\/\.cache)/;

/** The habits counted, each named by the rule it breaks. */
export const HABITS: readonly Habit[] = [
	{
		key: "tracked file edited from the shell",
		test: (_, c) =>
			(IN_PLACE_EDIT.test(c) || REDIRECT_EDIT.test(c)) && !IN_SCRATCH.test(c),
	},
	{
		key: "git stash run directly",
		test: (_, c) => /\bgit\s+stash\b(?!\s+(list|show))/.test(c),
	},
	{
		key: "sleep used to wait",
		test: (_, c) => /(^|[;&|(]\s*|\bdo\s+)sleep\s+\d/.test(c),
	},
	{
		key: "nice or ionice added",
		test: (_, c) => /(^|[;&|]\s*)(nice\s+(-n\s*)?-?\d|ionice\s+-c)/.test(c),
	},
	{
		key: "build or test output cut with tail or head",
		test: (_, c) => BUILD_OUTPUT_CUT.test(c),
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
	if (isError && toolName === "bash" && GUARD_LINE.test(trimmed)) {
		return [{ kind: "guard", key: normalise(trimmed.split("\n")[0]), sample }];
	}
	return [];
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

/** A signal seen in one session in one week. */
export interface Sighting extends Signal {
	readonly week: string;
	readonly session: string;
}

/** Signals of one kind and key, counted by distinct sessions. */
export interface Group {
	readonly kind: SignalKind;
	readonly key: string;
	readonly calls: number;
	readonly sessions: number;
	/** Distinct sessions per week. */
	readonly weeks: Readonly<Record<string, number>>;
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
			weeks: Map<string, Set<string>>;
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
				weeks: new Map(),
				samples: [],
			};
			groups.set(id, group);
		}
		group.calls++;
		group.sessions.add(s.session);
		const week = group.weeks.get(s.week) ?? new Set<string>();
		week.add(s.session);
		group.weeks.set(s.week, week);
		if (group.samples.length < SAMPLES) group.samples.push(s.sample);
	}
	return [...groups.values()]
		.map((g) => ({
			kind: g.kind,
			key: g.key,
			calls: g.calls,
			sessions: g.sessions.size,
			weeks: Object.fromEntries(
				[...g.weeks].map(([week, sessions]) => [week, sessions.size]),
			),
			samples: g.samples,
		}))
		.sort((a, b) => b.sessions - a.sessions || b.calls - a.calls);
}

const HEADINGS: Record<SignalKind, string> = {
	habit: "Habits",
	refusal: "Refusals",
	reason: "Reasons Given in Refusals",
	guard: "Shell Commands Guards Blocked",
};

/**
 * A markdown report: sessions active per week, then each kind's top
 * groups with distinct sessions per week.
 */
export function renderReport(
	groups: readonly Group[],
	active: Readonly<Record<string, number>>,
	options: { since: string; top: number },
): string {
	const weeks = Object.keys(active).sort();
	const lines = [
		`# Learning Sensor, Since ${options.since}`,
		"",
		`Sessions active: ${weeks.map((w) => `${w} ${active[w]}`).join(", ")}.`,
	];
	for (const kind of ["habit", "refusal", "reason", "guard"] as const) {
		const rows = groups.filter((g) => g.kind === kind).slice(0, options.top);
		if (rows.length === 0) continue;
		lines.push(
			"",
			`## ${HEADINGS[kind]}`,
			"",
			`| Sessions | Calls | ${weeks.join(" | ")} | What |`,
			`| ---: | ---: | ${weeks.map(() => "---:").join(" | ")} | --- |`,
		);
		for (const g of rows) {
			const cells = weeks.map((w) => String(g.weeks[w] ?? 0));
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
	message?: {
		role?: unknown;
		toolName?: unknown;
		isError?: unknown;
		content?: unknown;
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

/** Read one session file: its sightings and the weeks it was active. */
function scanSession(
	path: string,
	sinceMs: number,
): { sightings: Sighting[]; weeks: Set<string> } {
	const session = basename(path);
	const sightings: Sighting[] = [];
	const weeks = new Set<string>();
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		// Removed since it was listed: nothing to read.
		return { sightings, weeks };
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
		if (entry.type !== "message" || !entry.message) continue;
		const when = Date.parse(String(entry.timestamp));
		if (Number.isNaN(when) || when < sinceMs) continue;
		const week = isoWeek(when);
		weeks.add(week);
		const m = entry.message;
		const signals =
			m.role === "toolResult"
				? signalsFromResult(
						String(m.toolName),
						textOf(m.content),
						m.isError === true,
					)
				: m.role === "assistant"
					? callsOf(m.content).flatMap(signalsFromCall)
					: [];
		for (const s of signals) sightings.push({ ...s, week, session });
	}
	return { sightings, weeks };
}

function sessionFiles(): string[] {
	const root = join(homedir(), ".pi", "agent", "sessions");
	let dirs: string[];
	try {
		dirs = readdirSync(root);
	} catch {
		// No sessions yet: nothing to count.
		return [];
	}
	return dirs.flatMap((dir) => {
		try {
			return readdirSync(join(root, dir))
				.filter((name) => name.endsWith(".jsonl"))
				.map((name) => join(root, dir, name));
		} catch {
			// A file beside the session folders, not a folder.
			return [];
		}
	});
}

function main(): void {
	const args = process.argv.slice(2);
	const option = (name: string) => {
		const index = args.indexOf(name);
		return index >= 0 ? args[index + 1] : undefined;
	};
	const since = option("--since") ?? "1970-01-01";
	const sinceMs = Date.parse(since);
	const top = Number(option("--top") ?? 20);
	const sightings: Sighting[] = [];
	const active = new Map<string, number>();
	for (const file of sessionFiles()) {
		const scanned = scanSession(file, Number.isNaN(sinceMs) ? 0 : sinceMs);
		sightings.push(...scanned.sightings);
		for (const week of scanned.weeks)
			active.set(week, (active.get(week) ?? 0) + 1);
	}
	const groups = tally(sightings);
	process.stdout.write(
		renderReport(groups, Object.fromEntries(active), { since, top }),
	);
	const json = option("--json");
	if (json) writeFileSync(json, `${JSON.stringify(groups, null, 1)}\n`);
}

if (import.meta.main) {
	main();
}
