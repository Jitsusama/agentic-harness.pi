/**
 * Convention-recurrence sensor.
 *
 * Counts how often convention corrections recur in the pi
 * session logs, by category and by week, so the effect of the
 * convention gates can be measured: record a baseline before the
 * gates bite, re-run after, and watch the recurring categories
 * bend down. The same query that diagnosed the problem is the
 * sensor that tracks the fix.
 *
 * The classification is a deliberately high-precision heuristic.
 * It looks for the strong correction signals the diagnosis
 * surfaced (an emdash complaint, a Canadian-spelling correction,
 * an invented-section rebuke) rather than trying to catch every
 * phrasing. A trend that bends is the goal, not a precise census.
 *
 * Run it directly (Node strips the types):
 *
 *   node scripts/convention-recurrence.ts [--since YYYY-MM-DD]
 *
 * See the convention-recurrence-sensor-guide skill for the
 * method and how to read the output.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The recurring convention-correction categories. */
export type ConventionCategory =
	| "emdash"
	| "spelling"
	| "sections"
	| "slack-format"
	| "commit";

/** A category and the patterns whose presence signals it. */
const CATEGORY_PATTERNS: ReadonlyArray<readonly [ConventionCategory, RegExp]> =
	[
		["emdash", /em[\s-]?dash|\u2014|\\u2014/i],
		["spelling", /canadian|american spelling|british spelling|\bspelling\b/i],
		[
			"sections",
			/(don'?t|do not|stop|only|no new|invent\w*|extra)\b[^.]*\bsection|section[^.]*\b(it|i|you) mention/i,
		],
		[
			"slack-format",
			/pipe table|markdown table|render\w*[^.]*table|table[^.]*block|malformed list|number\w* list|image embed/i,
		],
		["commit", /conventional commit|commit (message|format)|imperative mood/i],
	];

/**
 * Classify a user-message text into the convention-correction
 * categories it signals. Returns every category whose pattern
 * matches, so one message can flag more than one.
 */
export function classifyCorrection(text: string): ConventionCategory[] {
	return CATEGORY_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(
		([category]) => category,
	);
}

/**
 * Bucket a date into an ISO year-week label like "2026-W22".
 * Accepts an ISO string or epoch milliseconds.
 */
export function isoWeek(date: number | string): string {
	const d = new Date(date);
	// ISO week: Thursday of the current week decides the year.
	const target = new Date(
		Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
	);
	const day = target.getUTCDay() || 7;
	target.setUTCDate(target.getUTCDate() + 4 - day);
	const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
	const week = Math.ceil(
		((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
	);
	return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ── Runner ──────────────────────────────────────────────────

/** A classified correction event from the logs. */
interface CorrectionEvent {
	readonly week: string;
	readonly category: ConventionCategory;
	readonly sessionId: string;
}

/** Pull the plain text from a user message's content blocks. */
function userText(message: unknown): string | null {
	if (
		!message ||
		typeof message !== "object" ||
		(message as { role?: unknown }).role !== "user"
	) {
		return null;
	}
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.length > 0 ? parts.join("\n") : null;
}

/** Scan one session file for classified correction events. */
function scanSession(path: string, sinceMs: number): CorrectionEvent[] {
	const events: CorrectionEvent[] = [];
	const sessionId = path;
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return events;
	}
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (
			!entry ||
			typeof entry !== "object" ||
			(entry as { type?: unknown }).type !== "message"
		) {
			continue;
		}
		const text = userText((entry as { message?: unknown }).message);
		if (!text) continue;
		const stamp = (entry as { timestamp?: unknown }).timestamp;
		const when =
			typeof stamp === "string" || typeof stamp === "number"
				? new Date(stamp).getTime()
				: Number.NaN;
		if (Number.isNaN(when) || when < sinceMs) continue;
		for (const category of classifyCorrection(text)) {
			events.push({ week: isoWeek(when), category, sessionId });
		}
	}
	return events;
}

/** Find every session JSONL under the pi sessions directory. */
function sessionFiles(): string[] {
	const root = join(homedir(), ".pi", "agent", "sessions");
	const files: string[] = [];
	let dirs: string[];
	try {
		dirs = readdirSync(root);
	} catch {
		return files;
	}
	for (const dir of dirs) {
		let inner: string[];
		try {
			inner = readdirSync(join(root, dir));
		} catch {
			continue;
		}
		for (const name of inner) {
			if (name.endsWith(".jsonl")) files.push(join(root, dir, name));
		}
	}
	return files;
}

/** Print a week-by-category table of distinct sessions per cell. */
function main(): void {
	const sinceArg = process.argv.indexOf("--since");
	const sinceMs =
		sinceArg >= 0 ? Date.parse(process.argv[sinceArg + 1] ?? "") : 0;

	const categories: ConventionCategory[] = [
		"emdash",
		"spelling",
		"sections",
		"slack-format",
		"commit",
	];
	// week -> category -> set of session ids (count distinct
	// sessions, so a session that gripes ten times counts once).
	const byWeek = new Map<string, Map<ConventionCategory, Set<string>>>();
	for (const file of sessionFiles()) {
		for (const event of scanSession(
			file,
			Number.isNaN(sinceMs) ? 0 : sinceMs,
		)) {
			let row = byWeek.get(event.week);
			if (!row) {
				row = new Map();
				byWeek.set(event.week, row);
			}
			let cell = row.get(event.category);
			if (!cell) {
				cell = new Set();
				row.set(event.category, cell);
			}
			cell.add(event.sessionId);
		}
	}

	const weeks = [...byWeek.keys()].sort();
	const header = ["week", ...categories].join("\t");
	const lines = [header];
	for (const week of weeks) {
		const row = byWeek.get(week);
		const cells = categories.map((c) => String(row?.get(c)?.size ?? 0));
		lines.push([week, ...cells].join("\t"));
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

if (import.meta.main) {
	main();
}
