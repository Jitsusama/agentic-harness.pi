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
 * session, such as bash after bash. A codemode script counts as one
 * call, since running several looks as one is what it is for.
 *
 * The counting runs in SQL, since a ledger query answers at most a few
 * thousand rows and a day holds over a hundred thousand turns.
 */

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
	const until = new Date(now).toISOString();
	const week = new Date(now - DAYS * DAY_MS).toISOString();
	const day = new Date(now - DAY_MS).toISOString();
	const shaped = await query(`
		WITH calls AS (
			SELECT session_id, entry_id, count(*) AS n
			FROM tool_calls WHERE timestamp >= '${week}'
			GROUP BY session_id, entry_id
		)
		SELECT
			cast(julianday('${until}') - julianday(t.timestamp) AS integer) AS ago,
			count(*) AS turns,
			sum(coalesce(c.n, 0) = 0) AS none,
			sum(c.n = 1) AS one,
			sum(c.n > 1) AS several
		FROM turns t
		LEFT JOIN calls c ON c.session_id = t.session_id AND c.entry_id = t.entry_id
		WHERE t.kind = 'assistant' AND t.timestamp >= '${week}' AND t.timestamp < '${until}'
		GROUP BY ago`);
	const tools = await query(`
		WITH calls AS (
			SELECT session_id, entry_id, count(*) AS n, min(name) AS tool
			FROM tool_calls WHERE timestamp >= '${day}'
			GROUP BY session_id, entry_id
		),
		steps AS (
			SELECT
				CASE WHEN c.n = 1 THEN c.tool END AS tool,
				lag(CASE WHEN c.n = 1 THEN c.tool END)
					OVER (PARTITION BY t.session_id ORDER BY t.timestamp) AS before
			FROM turns t
			LEFT JOIN calls c ON c.session_id = t.session_id AND c.entry_id = t.entry_id
			WHERE t.kind = 'assistant' AND t.timestamp >= '${day}' AND t.timestamp < '${until}'
		)
		SELECT tool, count(*) AS turns, sum(coalesce(before = tool, 0)) AS afterItself
		FROM steps WHERE tool IS NOT NULL
		GROUP BY tool ORDER BY turns DESC, tool LIMIT ${TOOLS_SHOWN}`);
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
		"The last day's one-call turns by tool, with how many came right after a one-call turn of the same tool in the same session, where looks that could have gone out together hide:",
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

function perHundred(part: number, whole: number): number {
	return whole === 0 ? 0 : Math.round((PER_HUNDRED * part) / whole);
}

/** A count from a row, where SQLite may answer null for an empty sum. */
function count(value: unknown): number {
	return typeof value === "number" ? value : Number(value ?? 0);
}
