/**
 * Turns doing one thing: how the model turns of the last seven days
 * divide by how many tool calls each made, for the daily measure.
 *
 * Every turn re-reads the session's whole context, so a turn that makes
 * one call pays the context's price for one call's work. On 10 to 11
 * November 2026, 79 turns in 100 made exactly one call. Some of those
 * needed the turn before; others were looks with no order between them
 * that could have gone out together. This counts the first and names
 * where the second may hide: each tool's one-call turns, and how many
 * came right after a one-call turn of the same tool in the same
 * session with only tool results between, such as bash after bash.
 * That is a ceiling: the ledger holds no mesh message, so a turn a
 * message started can still count. A codemode script counts as one
 * call, since running several looks as one is what it is for.
 *
 * The counting runs in SQL, in `one-call-days.sql` and
 * `one-call-tools.sql`, since a ledger query answers at most a few
 * thousand rows and a day holds over a hundred thousand turns.
 */

import { sqlFile } from "../lib/core/internal/sqlite/sql-file.ts";

/** Runs one read-only query against the ledger and answers its rows. */
export type LedgerQuery = (
	sql: string,
) => Promise<readonly Record<string, unknown>[]>;

/** One day's model turns, by how many tool calls each made. */
export interface TurnShape {
	/** The date the day's 24 hours end on, UTC. */
	readonly ending: string;
	readonly turns: number;
	readonly none: number;
	readonly one: number;
	readonly several: number;
}

/** A tool's one-call turns in the last day, and how many followed one of its own. */
export interface OneCallTool {
	readonly tool: string;
	readonly turns: number;
	readonly afterItself: number;
}

/** What the measure says about turns doing one thing. */
export interface OneCallReport {
	/** The last seven days, newest first. */
	readonly days: readonly TurnShape[];
	/** The last day's one-call turns by tool, most first. */
	readonly tools: readonly OneCallTool[];
}

const DAYS = 7;
const DAY_MS = 86_400_000;
const TOOLS_SHOWN = 8;
const PER_HUNDRED = 100;

/** Count the turns of the seven days before `now` by how many calls each made. */
export async function oneCallTurns(
	query: LedgerQuery,
	now: number,
): Promise<OneCallReport> {
	const shaped = await query(
		statement(
			sqlFile(new URL("./one-call-days.sql", import.meta.url), {
				since_ms: now - DAYS * DAY_MS,
				until_ms: now,
			}),
		),
	);
	const tools = await query(
		statement(
			sqlFile(new URL("./one-call-tools.sql", import.meta.url), {
				since_ms: now - DAY_MS,
				until_ms: now,
				shown: TOOLS_SHOWN,
			}),
		),
	);
	const byAgo = new Map(shaped.map((row) => [count(row.ago), row]));
	const days = Array.from({ length: DAYS }, (_, ago) => {
		const row = byAgo.get(ago);
		return {
			ending: new Date(now - ago * DAY_MS).toISOString().slice(0, 10),
			turns: count(row?.turns),
			none: count(row?.none),
			one: count(row?.one),
			several: count(row?.several),
		};
	});
	return {
		days,
		tools: tools.map((row) => ({
			tool: String(row.tool),
			turns: count(row.turns),
			afterItself: count(row.afterItself),
		})),
	};
}

/** The measure's section on turns doing one thing. */
export function formatOneCall(report: OneCallReport): string {
	const lines = ["## Turns Doing One Thing", ""];
	const week = report.days.reduce(
		(sum, day) => ({
			turns: sum.turns + day.turns,
			one: sum.one + day.one,
		}),
		{ turns: 0, one: 0 },
	);
	const latest = report.days.at(0);
	if (latest === undefined || latest.turns === 0) {
		lines.push("No model turns in the last day.", "");
		return lines.join("\n");
	}
	lines.push(
		`${perHundred(week.one, week.turns)} of 100 turns made exactly one tool call over the seven days, and ${perHundred(latest.one, latest.turns)} in the last one (${latest.one.toLocaleString("en-CA")} of ${latest.turns.toLocaleString("en-CA")}). Each pays a full read of its context for one call's work.`,
		"",
		"| Day ending | Turns | One call | None | Two or more |",
		"|---|---|---|---|---|",
		...report.days.map(
			(day) =>
				`| ${day.ending} | ${day.turns} | ${day.one} | ${day.none} | ${day.several} |`,
		),
		"",
		"The last day's one-call turns by tool, with how many came right after a one-call turn of the same tool in the same session, where looks that could have gone out together hide. At most: a turn a mesh message started leaves no mark in the ledger, so it can count too.",
		"",
		"| Tool | One-call turns | Right after its own |",
		"|---|---|---|",
		...report.tools.map(
			(tool) => `| ${tool.tool} | ${tool.turns} | ${tool.afterItself} |`,
		),
		"",
	);
	return lines.join("\n");
}

/** A query file without its leading comment, since the ledger takes only a statement that opens with SELECT or WITH. */
function statement(text: string): string {
	return text.replace(/^(?:--.*\n)+/, "");
}

function perHundred(part: number, whole: number): number {
	return whole === 0 ? 0 : Math.round((PER_HUNDRED * part) / whole);
}

/** A count from a row, where SQLite may answer null for an empty sum; what isn't a number reads as none. */
function count(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value ?? 0);
	return Number.isFinite(parsed) ? parsed : 0;
}
