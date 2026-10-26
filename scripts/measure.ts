/**
 * The measure, run with no pi session, as a timer does: the `spend`
 * tool's audit and the learning sensor's count, written as one report.
 *
 * It measures a day unless `--week` asks for a week. A day's audit
 * holds the last 24 hours against the 24 before: spend, cache
 * rewrites, the always-on context each repository pays for, the tools
 * that failed most and how much of the quest files sessions read. Its
 * sensor counts the refusals, guard blocks and habits that recurred
 * over the last seven days, day by day, so a harness change shows as
 * a bend in the days after it lands rather than a week later. A
 * week's measure is the audit's week and the sensor over the same
 * seven days, by ISO week.
 *
 * It indexes the session logs into the ledger first, as the tool
 * does before it answers, then reads the ledger read-only. The one
 * thing a session would add, which tools load on demand, is left
 * out, since only a running pi knows.
 *
 * The report goes to the `measure` folder of the package's state
 * directory, named for the day it ends (`-week` added for a week),
 * unless `--out` names a file. The path is printed.
 *
 * Node runs it as it stands, stripping the types; the project's
 * tsconfig refuses the syntax stripping can't take, so it stays so:
 *
 *   node scripts/measure.ts [--week] [--out <file>] [--top N]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatAudit, type Span } from "../extensions/spend-workflow/audit.ts";
import { gatherAudit } from "../extensions/spend-workflow/audit-input.ts";
import {
	indexSessionLogs,
	sessionsDir,
} from "../extensions/spend-workflow/indexer.ts";
import {
	openLedgerReader,
	openTurnStore,
} from "../lib/core/observability/index.ts";
import { packageStateDir } from "../lib/internal/package-state-dir.ts";
import { renderReport, sense } from "./learning-sensor.ts";

/** How far back a day's sensor looks, so each day reads beside six more. */
const SENSED_DAYS = 7;
const DAY_MS = 86_400_000;

/** Write the span's report and answer where it went. */
export async function measure(opts: {
	now: number;
	span: Span;
	out?: string;
	top?: number;
}): Promise<string> {
	const ledgerDir = packageStateDir("observability");
	mkdirSync(ledgerDir, { recursive: true });
	const ledger = join(ledgerDir, "ledger.db");
	const store = await openTurnStore(ledger);
	try {
		await indexSessionLogs(store, join(ledgerDir, "ledger-watermarks.json"));
	} finally {
		await store.close();
	}
	const reader = await openLedgerReader(ledger);
	let audit: string;
	let start: number;
	let from: string;
	let to: string;
	try {
		const input = await gatherAudit(
			async (sql) => (await reader.query(sql)).rows,
			{ now: opts.now, span: opts.span, sessionsDir: sessionsDir() },
		);
		audit = formatAudit(input, opts.top ?? 12);
		start = Date.parse(input.period.from);
		from = input.period.from.slice(0, 10);
		to = input.period.to.slice(0, 10);
	} finally {
		await reader.close();
	}
	// A week senses the audit's seven days to the minute; a day senses
	// the seven days before it, day by day.
	const sensedFrom =
		opts.span === "week" ? start : opts.now - SENSED_DAYS * DAY_MS;
	const { groups, active } = sense(sensedFrom, opts.span);
	const sensed = renderReport(groups, active, {
		since: new Date(sensedFrom).toISOString().slice(0, 10),
		top: opts.top ?? 20,
	}).replace(/^#/gm, "##");
	const title =
		opts.span === "week"
			? `# Weekly Measure, ${from} to ${to}`
			: `# Daily Measure, ${to}`;
	const report = [
		title,
		"",
		"## Audit",
		"",
		audit.trimEnd(),
		"",
		sensed.trimEnd(),
		"",
	].join("\n");
	const name = opts.span === "week" ? `${to}-week.md` : `${to}.md`;
	const out = opts.out ?? join(packageStateDir("measure"), name);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, report);
	return out;
}

const USAGE =
	"Usage: node scripts/measure.ts [--week] [--out <file>] [--top N]";

/**
 * What in `args` is not an option the script takes, or the value one
 * needs, so a mistyped run is refused rather than run as a full
 * measure.
 */
export function strayArguments(args: readonly string[]): string[] {
	const stray: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		const value = args[i + 1];
		if (arg === "--week") continue;
		if (
			(arg === "--out" || arg === "--top") &&
			value &&
			!value.startsWith("--")
		) {
			i++;
		} else stray.push(arg);
	}
	return stray;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const stray = strayArguments(args);
	if (stray.length > 0) {
		console.error(`Not an option this takes: ${stray.join(" ")}\n${USAGE}`);
		process.exit(2);
	}
	const option = (name: string) => {
		const index = args.indexOf(name);
		return index >= 0 ? args[index + 1] : undefined;
	};
	const span: Span = args.includes("--week") ? "week" : "day";
	const top = option("--top");
	const out = await measure({
		now: Date.now(),
		span,
		...(option("--out") ? { out: option("--out") } : {}),
		...(top ? { top: Number(top) } : {}),
	});
	console.log(
		`Wrote the ${span === "week" ? "weekly" : "daily"} measure to ${out}.`,
	);
}

if (import.meta.main) {
	await main();
}
