/**
 * What each line said into the void cost, for the daily measure.
 *
 * The void is one small session that takes a line Joel says once and
 * sends it where it belongs. It writes each line to a day file first,
 * as `- HH:MM <his words> → <where it went>`, in local time. Its turns
 * are booked in the ledger to its quest, so each turn that came within
 * minutes of a line is that line's cost, and the rest (starting, a
 * cold wake, anything between lines) is the void's upkeep. Measured
 * rather than estimated, as asked of it from its first day (WCJQSG,
 * 12 November 2026). The measure says where each line went, never
 * his words.
 */

import type { LedgerQuery } from "./one-call.ts";

/** The void's quest, which every one of its turns is booked to. */
export const VOID_QUEST = "QEST-20261112-8GYNJ6";

/** One line the void took, and what routing it cost. */
export interface VoidLine {
	/** The day file's date, `YYYY-MM-DD`. */
	readonly day: string;
	/** Its local time, `HH:MM`. */
	readonly at: string;
	/** What the void noted after the arrow: where it went. */
	readonly went: string;
	readonly turns: number;
	readonly cost: number;
}

/** The void's day: its lines, and what its other turns cost. */
export interface VoidCostReport {
	readonly lines: readonly VoidLine[];
	/** Turns no line explains: starting, cold wakes, between lines. */
	readonly upkeep: number;
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** How long after a line a turn still counts as routing it. */
const LINE_MINUTES = 10;
/** Cost is kept to a hundredth of a cent, so sums read as they add. */
const COST_PLACES = 10_000;
const ARROW = " → ";

/** Book the void's turns of the day before `now` to the lines its day files hold. */
export async function voidCost(
	readDay: (date: string) => string | undefined,
	query: LedgerQuery,
	now: number,
	zone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Promise<VoidCostReport> {
	const since = now - DAY_MS;
	const clock = localClock(zone);
	const from = clock(since);
	const to = clock(now);
	const days = [...new Set([from.day, to.day])];
	const lines = days
		.flatMap((day) => linesOf(day, readDay(day) ?? ""))
		.filter((line) => line.stamp >= from.stamp && line.stamp <= to.stamp);
	const rows = await query(
		`SELECT timestamp, cost_total AS cost FROM turns WHERE quest = '${VOID_QUEST}' AND timestamp >= '${new Date(since).toISOString()}' AND timestamp < '${new Date(now).toISOString()}' ORDER BY timestamp`,
	);
	const booked = lines.map(() => ({ turns: 0, cost: 0 }));
	let upkeep = 0;
	for (const row of rows) {
		const at = Date.parse(String(row.timestamp));
		const cost = Number(row.cost);
		const spent = Number.isFinite(cost) ? cost : 0;
		const index = lineBefore(lines, clock, at);
		const tally = index === undefined ? undefined : booked[index];
		if (tally === undefined) {
			upkeep += spent;
		} else {
			tally.turns += 1;
			tally.cost += spent;
		}
	}
	return {
		lines: lines.map((line, index) => ({
			day: line.day,
			at: line.at,
			went: line.went,
			turns: booked[index]?.turns ?? 0,
			cost: rounded(booked[index]?.cost ?? 0),
		})),
		upkeep: rounded(upkeep),
	};
}

/** The measure's section on the void. */
export function formatVoidCost(report: VoidCostReport): string {
	const lines = ["## The Void", ""];
	if (report.lines.length === 0) {
		lines.push(
			`The void took no line in the last day. Its upkeep cost ${dollars(report.upkeep)}.`,
			"",
		);
		return lines.join("\n");
	}
	const total = report.lines.reduce((sum, line) => sum + line.cost, 0);
	lines.push(
		`The void took ${report.lines.length} lines in the last day, for ${dollars(total)} in all, read from the ledger. Its upkeep (starting, cold wakes, turns between lines) cost ${dollars(report.upkeep)} more.`,
		"",
		"| Line at | Went | Turns | Cost |",
		"|---|---|---|---|",
		...report.lines.map(
			(line) =>
				`| ${line.day} ${line.at} | ${line.went} | ${line.turns} | ${dollars(line.cost)} |`,
		),
		"",
	);
	return lines.join("\n");
}

/** A line of a day file, with its local stamp to compare by. */
interface DayLine {
	readonly day: string;
	readonly at: string;
	readonly went: string;
	/** `YYYY-MM-DD HH:MM`, local, which sorts as time does. */
	readonly stamp: string;
}

/** The lines of one day file. */
function linesOf(day: string, text: string): DayLine[] {
	const lines: DayLine[] = [];
	for (const raw of text.split("\n")) {
		const match = /^- (\d{2}:\d{2}) /.exec(raw);
		const at = match?.at(1);
		if (at === undefined) continue;
		const arrow = raw.lastIndexOf(ARROW);
		const went = arrow < 0 ? "not yet noted" : raw.slice(arrow + ARROW.length);
		lines.push({ day, at, went: went.trim(), stamp: `${day} ${at}` });
	}
	return lines;
}

/** The newest line at or before `at`, if it is within minutes. */
function lineBefore(
	lines: readonly DayLine[],
	clock: (ms: number) => { stamp: string },
	at: number,
): number | undefined {
	const now = clock(at).stamp;
	const soon = clock(at - LINE_MINUTES * MINUTE_MS).stamp;
	let found: number | undefined;
	lines.forEach((line, index) => {
		if (line.stamp <= now && line.stamp >= soon) found = index;
	});
	return found;
}

/** A clock reading instants as a day and a minute in `zone`. */
function localClock(
	zone: string,
): (ms: number) => { day: string; stamp: string } {
	const format = new Intl.DateTimeFormat("en-CA", {
		timeZone: zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	return (ms) => {
		const parts = Object.fromEntries(
			format.formatToParts(new Date(ms)).map((part) => [part.type, part.value]),
		);
		const day = `${parts.year}-${parts.month}-${parts.day}`;
		return { day, stamp: `${day} ${parts.hour}:${parts.minute}` };
	};
}

function rounded(value: number): number {
	return Math.round(value * COST_PLACES) / COST_PLACES;
}

function dollars(value: number): string {
	return `$${value.toFixed(2)}`;
}
