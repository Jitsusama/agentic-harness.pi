/**
 * The weekly measure, run with no pi session, as a timer does: the
 * `cost` tool's weekly audit and the learning sensor's count over the
 * same week, written as one report.
 *
 * The audit holds the week against the one before: spend, cache
 * rewrites, the always-on context each repository pays for, the
 * tools that failed most and how much of the quest files sessions
 * read. The sensor counts the refusals, guard blocks and habits that
 * recurred, by distinct sessions per ISO week. Together they show
 * whether a harness change made a mistake recur less.
 *
 * It indexes the session logs into the ledger first, as the tool
 * does before it answers, then reads the ledger read-only. The one
 * thing a session would add, which tools load on demand, is left
 * out, since only a running pi knows.
 *
 * The report goes to the `measure` folder of the package's state
 * directory, named for the day the week ends, unless `--out` names a
 * file. The path is printed.
 *
 * The ledger's classes use TypeScript parameter properties, which
 * Node's default type stripping refuses, so run it with the transform:
 *
 *   node --experimental-transform-types scripts/weekly-measure.ts
 *     [--out <file>] [--top N]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatAudit } from "../extensions/cost-workflow/audit.ts";
import { gatherAudit } from "../extensions/cost-workflow/audit-input.ts";
import {
	indexSessionLogs,
	sessionsDir,
} from "../extensions/cost-workflow/indexer.ts";
import {
	openLedgerReader,
	openTurnStore,
} from "../lib/core/observability/index.ts";
import { packageStateDir } from "../lib/internal/package-state-dir.ts";
import { renderReport, sense } from "./learning-sensor.ts";

/** Write the week's report and answer where it went. */
export async function measureWeek(opts: {
	now: number;
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
			{ now: opts.now, sessionsDir: sessionsDir() },
		);
		audit = formatAudit(input, opts.top ?? 12);
		start = Date.parse(input.week.from);
		from = input.week.from.slice(0, 10);
		to = input.week.to.slice(0, 10);
	} finally {
		await reader.close();
	}
	// The same seven days the audit reads, to the minute.
	const { groups, active } = sense(start);
	const sensed = renderReport(groups, active, {
		since: from,
		top: opts.top ?? 20,
	}).replace(/^#/gm, "##");
	const report = [
		`# Weekly Measure, ${from} to ${to}`,
		"",
		"## Audit",
		"",
		audit.trimEnd(),
		"",
		sensed.trimEnd(),
		"",
	].join("\n");
	const out = opts.out ?? join(packageStateDir("measure"), `${to}.md`);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, report);
	return out;
}

const USAGE =
	"Usage: node --experimental-transform-types scripts/weekly-measure.ts [--out <file>] [--top N]";

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
	const top = option("--top");
	const out = await measureWeek({
		now: Date.now(),
		...(option("--out") ? { out: option("--out") } : {}),
		...(top ? { top: Number(top) } : {}),
	});
	console.log(`Wrote the weekly measure to ${out}.`);
}

if (import.meta.main) {
	await main();
}
