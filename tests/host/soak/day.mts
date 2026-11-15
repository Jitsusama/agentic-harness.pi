// A day of the week's soak, from the command line: the turns it takes, and what its run left.
/**
 * scripts/soak-day.sh runs a day of the week on lent builders and calls
 * this either side of it:
 *
 *   node tests/host/soak/day.mts turns DAY
 *     prints day DAY's (1 to 7) conversations' turns, comma-separated,
 *     for --turns, from week.json as week.ts cuts it.
 *   node tests/host/soak/day.mts read LOG DIR
 *     reads the report the soak printed into LOG, writes report.json,
 *     turns.json, wakes.json and figures.json into DIR, and prints the
 *     figures as one JSON line; it exits 1 when LOG holds no report.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { figuresOf, filesOf, reportIn } from "./day.ts";
import { daysOf } from "./week.ts";

const [command, ...rest] = process.argv.slice(2);
if (command === "turns") {
	const day = Number(rest[0]);
	const week: unknown = JSON.parse(
		readFileSync(resolve(import.meta.dirname, "week.json"), "utf8"),
	);
	const sessions = Array.isArray(week)
		? week.filter((one): one is number => typeof one === "number")
		: [];
	const turns = daysOf(sessions)[day - 1];
	if (!Number.isInteger(day) || turns === undefined)
		throw new Error(`day.mts turns DAY: DAY is 1 to 7, not ${rest[0]}`);
	process.stdout.write(`${turns.join(",")}\n`);
} else if (command === "read") {
	const [log, dir] = rest;
	if (log === undefined || dir === undefined)
		throw new Error("day.mts read LOG DIR");
	const report = reportIn(readFileSync(log, "utf8"));
	if (report === undefined) {
		process.stderr.write(`day.mts: ${log} holds no soak report\n`);
		process.exit(1);
	}
	mkdirSync(dir, { recursive: true });
	const figures = figuresOf(report);
	for (const [name, value] of Object.entries({
		...filesOf(report),
		"figures.json": figures,
	}))
		writeFileSync(join(dir, name), `${JSON.stringify(value, null, 1)}\n`);
	process.stdout.write(`${JSON.stringify(figures)}\n`);
} else {
	throw new Error("day.mts turns DAY | day.mts read LOG DIR");
}
