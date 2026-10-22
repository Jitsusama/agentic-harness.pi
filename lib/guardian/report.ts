/**
 * Guard reports: what a guard saw, put in the transcript for the person.
 *
 * A guard that lets an action through, because it is off, because the
 * agent overrode a redirect, or because it fixed the action itself,
 * hands over a report. The report travels as plain data, because it is
 * stored as a session entry and drawn later by whatever renderer the
 * session has, so it holds markdown rather than a render closure.
 *
 * Entries never reach the model's context, so a report costs no tokens
 * and leaves the prompt prefix alone. That is also why a report alone
 * teaches the agent nothing: what the agent must learn from reaches it
 * as a refusal in its own tool result, under `redirect` or `block`.
 *
 * Reports go to a sink the policy workflow installs. With no sink
 * installed they are dropped, which is also what an uninstalled
 * renderer would amount to: there is nobody to show them to.
 */

/** The custom entry type a report is stored under. */
export const GUARD_REPORT_ENTRY = "guard-report";

/**
 * What became of the action the guard looked at.
 *
 * - shown: an approval that would have asked, and went ahead.
 * - waved: a refusal from a guard that is off, and the action went ahead.
 * - overridden: a redirect the agent made again unchanged, so it went ahead.
 * - fixed: the guard made the change itself and let it through.
 * - held: an approval kept for the person's return, since they are away.
 */
export type GuardReportKind =
	| "shown"
	| "waved"
	| "overridden"
	| "fixed"
	| "held";

const REPORT_KINDS: readonly string[] = [
	"shown",
	"waved",
	"overridden",
	"fixed",
	"held",
];

/** One guard's report, as stored. */
export interface GuardReport {
	/** The guard's declared name. */
	readonly guard: string;
	readonly kind: GuardReportKind;
	/** What the panel would have been titled, or what was fixed. */
	readonly title: string;
	/** The content, as markdown. */
	readonly body?: string;
	/** Short marks shown under the body, such as validation results. */
	readonly notes?: readonly string[];
}

/** Where reports go. */
export type GuardReportSink = (report: GuardReport) => void;

const SINK_KEY = Symbol.for("pi:guard-report-sink");

type GlobalSink = Record<symbol, GuardReportSink | undefined>;

/** Install the sink reports go to. Passing undefined removes it. */
export function setGuardReportSink(sink: GuardReportSink | undefined): void {
	(globalThis as GlobalSink)[SINK_KEY] = sink;
}

/** Hand a report to the installed sink, if there is one. */
export function reportGuard(report: GuardReport): void {
	(globalThis as GlobalSink)[SINK_KEY]?.(report);
}

/** Whether a stored entry's data reads as a report. */
export function isGuardReport(value: unknown): value is GuardReport {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.guard === "string" &&
		typeof record.title === "string" &&
		typeof record.kind === "string" &&
		REPORT_KINDS.includes(record.kind)
	);
}
