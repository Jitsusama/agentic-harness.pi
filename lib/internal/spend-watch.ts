/**
 * The bill, as spend-watch keeps it.
 *
 * The ledger prices pi's logs at the prices pi put on each request,
 * which run well above a negotiated bill. spend-watch, where it is
 * installed, holds the bill wherever a feed gives one, so the spend
 * tool asks it rather than quoting list prices as what was paid.
 *
 * It is asked only through its command line's JSON, never its files:
 * the command is its contract, and most machines this package runs on
 * have no spend-watch at all. Any failure (not installed, too slow, an
 * answer that isn't a report) is no bill, never an error, since the
 * ledger's own answer still stands.
 */

import type { Exec } from "../core/exec/index.ts";
import { isRecord } from "./record.ts";

/** The periods spend-watch answers for, in its own words. */
export const BILL_PERIODS = [
	"today",
	"yesterday",
	"this week",
	"last week",
	"this month",
	"last month",
	"30 days",
] as const;

/** One of the periods spend-watch answers for. */
export type BillPeriod = (typeof BILL_PERIODS)[number];

/** The ledger's groupings spend-watch also cuts by. */
export const BILL_CUTS = ["repo", "quest", "model", "day", "session"] as const;

/** A grouping spend-watch can cut its bill by. */
export type BillCut = (typeof BILL_CUTS)[number];

/** The command, as the spend-watch module installs it. */
const COMMAND = "spend-watch";

/** One line of the bill: a quest, a model, a day or the like. */
export interface BillRow {
	name: string;
	dollars: number;
	/** The amount as spend-watch writes it, e.g. "$1,232". */
	shown: string;
	/** Worked out from pi's logs rather than billed ("about"). */
	estimated: boolean;
}

/** What spend-watch says a period cost. */
export interface Bill {
	title: string;
	from: string;
	to: string;
	total: number;
	shown: string;
	/** Which figure it is, e.g. "billed, the latest hours from the live meter". */
	source: string;
	rows: BillRow[];
	notes: string[];
}

/** Whether a grouping is one spend-watch also cuts by. */
export function isBillCut(value: string): value is BillCut {
	return (BILL_CUTS as readonly string[]).includes(value);
}

/**
 * Ask spend-watch what a period cost, cut one way or as a whole.
 * Undefined when it isn't installed, fails, or answers with something
 * that isn't a report.
 */
export async function askBill(
	exec: Exec,
	period: BillPeriod,
	cut?: BillCut,
): Promise<Bill | undefined> {
	const args = [
		"report",
		period,
		...(cut ? ["by", cut] : []),
		"--format",
		"json",
	];
	const result = await exec(COMMAND, args);
	if (result.code !== 0) return undefined;
	try {
		return billFrom(JSON.parse(result.stdout));
	} catch {
		// Output that isn't JSON is no report, and the ledger's answer stands.
		return undefined;
	}
}

/** Read a parsed report, or undefined when it isn't one. */
export function billFrom(value: unknown): Bill | undefined {
	if (!isRecord(value)) return undefined;
	const { title, from, to, total, shown, source, rows, notes } = value;
	if (
		typeof title !== "string" ||
		typeof from !== "string" ||
		typeof to !== "string" ||
		typeof total !== "number" ||
		!Number.isFinite(total) ||
		typeof shown !== "string" ||
		typeof source !== "string" ||
		!Array.isArray(rows)
	) {
		return undefined;
	}
	return {
		title,
		from,
		to,
		total,
		shown,
		source,
		rows: rows.flatMap((row) => {
			const read = rowFrom(row);
			return read ? [read] : [];
		}),
		notes: Array.isArray(notes)
			? notes.filter((note): note is string => typeof note === "string")
			: [],
	};
}

/** One row, or undefined when it lacks what a row needs. */
function rowFrom(value: unknown): BillRow | undefined {
	if (!isRecord(value)) return undefined;
	const { name, dollars, shown, estimated } = value;
	if (
		typeof name !== "string" ||
		typeof dollars !== "number" ||
		!Number.isFinite(dollars) ||
		typeof shown !== "string"
	) {
		return undefined;
	}
	return { name, dollars, shown, estimated: estimated === true };
}
