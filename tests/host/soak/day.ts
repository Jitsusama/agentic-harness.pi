/**
 * What a day's soak run leaves to check it by. A lender sends back only
 * what the soak printed, so the report is read from its `soak report:`
 * line and cut into the files a reader checks the figures against: the
 * whole report, each hosted turn's times, and each wake. Beside them, the
 * day's figures in one record: faults and parity, latency and the bar,
 * and what bursts cost apart from it, since Joel's conversations do wake
 * in bursts and a burst figure that climbs from day to day is a finding.
 */
import { isRecord } from "../../../lib/internal/record.ts";
import { spreadOf } from "./report.ts";

/** What a soak prints its report after. */
const REPORT_LEAD = "soak report: ";

/** The files a day's run is checked by, by name, each a JSON value. */
export interface DayFiles {
	readonly "report.json": unknown;
	readonly "turns.json": unknown;
	readonly "wakes.json": unknown;
}

/** The report a soak printed in `said`, or nothing when it never did. */
export function reportIn(said: string): Record<string, unknown> | undefined {
	const line = said
		.split("\n")
		.reverse()
		.find((one) => one.startsWith(REPORT_LEAD));
	if (line === undefined) return undefined;
	const report: unknown = JSON.parse(line.slice(REPORT_LEAD.length));
	return isRecord(report) ? report : undefined;
}

/** The files `report` is checked by. */
export function filesOf(report: Record<string, unknown>): DayFiles {
	return {
		"report.json": report,
		"turns.json": report.turnsTimed ?? [],
		"wakes.json": {
			opened: report.opened,
			checkpoints: listOf(report.checkpoints).map((checkpoint, index) =>
				isRecord(checkpoint)
					? {
							checkpoint: index + 1,
							turnsDone: checkpoint.turnsDone,
							atMs: checkpoint.atMs,
							windowWakes: checkpoint.windowWakes,
							burstWakes: checkpoint.burstWakes,
							afterBurst: checkpoint.afterBurst,
						}
					: { checkpoint: index + 1 },
			),
			restart: report.restart,
			restartMid: report.restartMid,
		},
	};
}

/**
 * The day's figures from `report`: what went wrong, how far the records
 * differ from plain pi's, the latency and the bar it was judged by, the
 * bursts' keys and wakes, the opening's loop, memory at each checkpoint
 * and the restarts.
 */
export function figuresOf(
	report: Record<string, unknown>,
): Record<string, unknown> {
	const latency = recordOf(report.latency);
	const screen = recordOf(latency.screen);
	const checkpoints = listOf(report.checkpoints).map(recordOf);
	const burstWakes = checkpoints.flatMap((checkpoint) =>
		answeredIn(checkpoint.burstWakes),
	);
	return {
		turns: report.turns,
		conversations: report.conversations,
		pace: report.pace,
		faults: listOf(report.faults).length,
		errors:
			listOf(report.hostErrors).length + listOf(report.plainErrors).length,
		parityUnexpected: listOf(report.parity).reduce<number>(
			(sum, one) => sum + numberOf(recordOf(one).unexpected),
			0,
		),
		latency: {
			hosted: latency.hosted,
			plain: latency.plain,
			paired: latency.paired,
		},
		bar: latency.bar,
		burst: {
			keys: recordOf(screen.burst).keyToAccepted,
			wakes: spreadOf(burstWakes),
			slowestByCheckpoint: checkpoints.map((checkpoint) =>
				Math.max(0, ...answeredIn(checkpoint.burstWakes)),
			),
		},
		openingLoopMaxMs: recordOf(recordOf(report.opened).weight).loopMaxMs,
		openedMs: recordOf(report.opened).ms,
		awakePssKb: checkpoints.map((checkpoint) => recordOf(checkpoint.awake).pss),
		heap: report.heap,
		restart:
			report.restart === undefined ? undefined : restartOf(report.restart),
		restartMid: report.restartMid,
		real: report.real === undefined ? undefined : realOf(report.real),
	};
}

/** A real-model slice's model, how many requests it refused, and each side's tokens. */
function realOf(real: unknown): Record<string, unknown> {
	const { model, refusals, usage } = recordOf(real);
	return { model, refusals: listOf(refusals).length, usage };
}

/** A restart's times, its wakes summed to their spread. */
function restartOf(restart: unknown): Record<string, unknown> {
	const { wakes, after, ...rest } = recordOf(restart);
	return {
		...rest,
		wakes: spreadOf(answeredIn(wakes)),
		loopMaxMs: recordOf(after).loopMaxMs,
	};
}

/** The answered times of each wake in `wakes`. */
function answeredIn(wakes: unknown): number[] {
	return listOf(wakes).flatMap((wake) => {
		const ms = recordOf(wake).answeredMs;
		return typeof ms === "number" ? [ms] : [];
	});
}

function listOf(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function recordOf(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function numberOf(value: unknown): number {
	return typeof value === "number" ? value : 0;
}
