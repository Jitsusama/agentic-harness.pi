/**
 * The weekly audit: one answer to "where did the week go, and what is
 * worth fixing", so a session does not have to assemble it from five
 * reports and a dozen queries, which is what every audit so far has
 * cost.
 *
 * It holds the week against the one before on four things: what was
 * spent and on what, the cache rewrites and their causes, the
 * always-on context each repository pays for on every turn, and the
 * tools whose calls failed most.
 */

import { homedir } from "node:os";
import { count } from "../../lib/ui/count.ts";
import type { StandingByRepo } from "./standing.ts";

/** A week, as the ISO timestamps that bound it. */
export interface Week {
	readonly from: string;
	readonly to: string;
}

/** The week ending `now`, and the one before it. */
export function weeks(now: number): { current: Week; prior: Week } {
	const day = 86_400_000;
	const iso = (at: number) => new Date(at).toISOString();
	return {
		current: { from: iso(now - 7 * day), to: iso(now) },
		prior: { from: iso(now - 14 * day), to: iso(now - 7 * day) },
	};
}

const within = (week: Week) =>
	`timestamp >= '${week.from}' AND timestamp < '${week.to}'`;

/** The queries the audit asks the ledger, each for one week. */
export const AUDIT_QUERIES = {
	spend: (week: Week) =>
		`SELECT count(*) AS turns, coalesce(sum(cost), 0) AS cost, coalesce(sum(cost_cache_read), 0) AS reads, coalesce(sum(cost_cache_write), 0) AS writes, coalesce(sum(cost_output), 0) AS output FROM turn_facts WHERE kind = 'assistant' AND ${within(week)}`,
	rewrites: (week: Week) =>
		`SELECT cause, count(*) AS times, coalesce(sum(excess_cost), 0) AS cost FROM misses WHERE ${within(week)} GROUP BY cause ORDER BY cost DESC`,
	readsByRepo: (week: Week) =>
		`SELECT coalesce(repo, cwd, '(no repository)') AS repo, count(*) AS turns, coalesce(sum(cost_cache_read), 0) AS cost, coalesce(sum(tokens_cache_read), 0) AS tokens FROM turn_facts WHERE kind = 'assistant' AND ${within(week)} GROUP BY 1`,
	errors: (week: Week) =>
		`SELECT name, count(*) AS calls, sum(is_error) AS failed FROM tool_calls WHERE ${within(week)} GROUP BY name HAVING sum(is_error) > 0 ORDER BY failed DESC LIMIT 8`,
	sessions: (week: Week) =>
		`SELECT count(DISTINCT session_id) AS sessions FROM turn_facts WHERE kind = 'assistant' AND ${within(week)}`,
	// pi's tool_search answers exactly NO_MATCH when it finds nothing.
	searches: (week: Week) =>
		`SELECT count(*) AS calls, count(DISTINCT session_id) AS sessions, coalesce(sum(result_chars = ${NO_MATCH.length}), 0) AS empty FROM tool_calls WHERE name = 'tool_search' AND ${within(week)}`,
	hidden: (week: Week, names: readonly string[]) =>
		`SELECT name, count(*) AS calls, count(DISTINCT session_id) AS sessions FROM tool_calls WHERE ${within(week)} AND name IN (${names.map((name) => `'${name.replaceAll("'", "''")}'`).join(", ") || "''"}) GROUP BY name ORDER BY sessions DESC, calls DESC`,
} as const;

/** What pi's tool_search answers when nothing matched. */
export const NO_MATCH = "No matching tools found.";

/**
 * The share of sessions past which a hidden tool is worth declaring on
 * every turn again. Loading costs about its declaration once a session;
 * declaring it costs that on every turn of every session, so a tool
 * most sessions load is cheaper declared.
 */
const DECLARE_SHARE = 0.25;

type Row = Readonly<Record<string, unknown>>;

const num = (value: unknown) => (typeof value === "number" ? value : 0);
const dollars = (value: number) =>
	`$${value.toLocaleString("en-CA", {
		minimumFractionDigits: value < 10 ? 2 : 0,
		maximumFractionDigits: value < 10 ? 2 : 0,
	})}`;
const home = homedir();
/** A working directory under the home directory, said from `~`. */
const shown = (repo: string) =>
	repo === home || repo.startsWith(`${home}/`)
		? `~${repo.slice(home.length)}`
		: repo;
const thousands = (value: number) =>
	value >= 10_000 ? `${Math.round(value / 1000)}k` : String(value);

/** "up 12%", "down 3%", or nothing when there is nothing to compare. */
function change(now: number, before: number): string {
	if (before <= 0) return "";
	const percent = Math.round(((now - before) / before) * 100);
	if (percent === 0) return ", the same as the week before";
	return `, ${percent > 0 ? "up" : "down"} ${Math.abs(percent)}% on the week before`;
}

/**
 * Characters a token, measured on 22 October: a first request of
 * 213,300 characters wrote 76,348 tokens to the cache.
 */
const CHARS_PER_TOKEN = 2.8;

/** What one week's audit was built from. */
export interface AuditInput {
	readonly week: Week;
	readonly spend: { readonly now: Row; readonly before: Row };
	readonly rewrites: readonly Row[];
	readonly reads: readonly Row[];
	readonly errors: readonly Row[];
	readonly standing: readonly StandingByRepo[];
	/** Session logs that held no system message to read. */
	readonly unread: number;
	/** How sessions found and used the tools that load on demand. */
	readonly loading?: {
		readonly sessions: number;
		readonly searches: Row;
		readonly hidden: readonly Row[];
	};
}

/**
 * Whether hiding tools cost anything: how often sessions searched, how
 * often a search found nothing, and which hidden tools sessions reached
 * for, naming any used in enough sessions to be cheaper declared.
 */
function loadingLines(loading: NonNullable<AuditInput["loading"]>): string[] {
	const { sessions, searches, hidden } = loading;
	const lines = ["Tools that load on demand:"];
	lines.push(
		`- tool_search: ${count(num(searches.calls), "call")} in ${count(num(searches.sessions), "session")}; ${num(searches.empty)} found nothing.`,
	);
	if (hidden.length === 0) {
		lines.push("- No hidden tool was called.");
		return lines;
	}
	const used = hidden
		.slice(0, 8)
		.map(
			(row) =>
				`${String(row.name)} in ${num(row.sessions)} of ${sessions} (${count(num(row.calls), "call")})`,
		)
		.join("; ");
	lines.push(`- Used: ${used}.`);
	const wanted = hidden
		.filter(
			(row) => sessions > 0 && num(row.sessions) / sessions > DECLARE_SHARE,
		)
		.map((row) => String(row.name));
	lines.push(
		wanted.length === 0
			? "- None is used in more than a quarter of sessions, so none is worth declaring on every turn."
			: `- Used in more than a quarter of sessions, so cheaper declared on every turn: ${wanted.join(", ")}.`,
	);
	return lines;
}

/** The audit, as the model and the person read it. */
export function formatAudit(input: AuditInput, limit: number): string {
	const { now, before } = input.spend;
	const lines: string[] = [
		`Audit of ${input.week.from.slice(0, 10)} to ${input.week.to.slice(0, 10)}.`,
		"",
		`Spend: ${dollars(num(now.cost))} over ${count(num(now.turns), "turn")}${change(num(now.cost), num(before.cost))}. Cache reads ${dollars(num(now.reads))}, cache writes ${dollars(num(now.writes))}, output ${dollars(num(now.output))}.`,
	];

	lines.push("", "Cache rewrites, by cause:");
	if (input.rewrites.length === 0) lines.push("- none");
	for (const row of input.rewrites) {
		lines.push(
			`- ${String(row.cause)}: ${count(num(row.times), "time")}, ${dollars(num(row.cost))}`,
		);
	}

	const readCost = new Map(
		input.reads.map((row) => [String(row.repo), row] as const),
	);
	lines.push(
		"",
		"Always-on context each turn reads, by repository (median session):",
	);
	if (input.standing.length === 0) lines.push("- no session logs to read");
	for (const repo of input.standing.slice(0, limit)) {
		const reads = readCost.get(repo.repo);
		const perToken =
			num(reads?.tokens) > 0 ? num(reads?.cost) / num(reads?.tokens) : 0;
		const weekly =
			(repo.total / CHARS_PER_TOKEN) * num(reads?.turns) * perToken;
		const biggest = repo.pieces
			.slice(0, 3)
			.map(([name, size]) => `${name} ${thousands(size)}`)
			.join(", ");
		const cost = weekly > 0 ? `, about ${dollars(weekly)} a week in reads` : "";
		lines.push(
			`- ${shown(repo.repo)}: ${thousands(repo.total)} characters over ${count(repo.sessions, "session")}${cost}. Largest: ${biggest}.`,
		);
	}
	if (input.unread > 0) {
		lines.push(
			`(${count(input.unread, "log")} held no system message to read and are left out.)`,
		);
	}

	if (input.loading) lines.push("", ...loadingLines(input.loading));

	lines.push("", "Tools whose calls failed most:");
	if (input.errors.length === 0) lines.push("- none");
	for (const row of input.errors) {
		const calls = num(row.calls);
		const failed = num(row.failed);
		const rate = calls > 0 ? Math.round((failed / calls) * 100) : 0;
		lines.push(`- ${String(row.name)}: ${failed} of ${calls} (${rate}%)`);
	}
	return lines.join("\n");
}
