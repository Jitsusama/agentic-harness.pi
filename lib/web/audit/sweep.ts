/**
 * Running a check under several conditions at once.
 *
 * Most layout and contrast faults are conditional. A page is
 * fine at 1280 and unusable at 375; a colour pair passes in
 * light and fails in dark. Checking one condition and reporting
 * a pass is how those ship.
 *
 * The table comes first and the detail second, because the
 * useful question is almost never "what is wrong" but "where
 * does it start going wrong". A run of passes ending in two
 * failures at the narrow end says more than either verdict does
 * alone.
 */

import type { Standing, Verdict } from "./verdict.js";
import { renderVerdict } from "./verdict.js";

/** One condition a check was run under. */
export interface Condition {
	/** How the condition reads in a table, e.g. "375px". */
	readonly label: string;
	readonly standing: Standing;
	/** The one-line result under this condition. */
	readonly headline: string;
	/** The full report, kept for when it is asked for. */
	readonly detail: string;
}

/** The worst standing among several. */
export function worstOf(standings: readonly Standing[]): Standing {
	if (standings.includes("fail")) return "fail";
	return standings.includes("warn") ? "warn" : "pass";
}

const MARK: Readonly<Record<Standing, string>> = {
	pass: "pass",
	warn: "warn",
	fail: "FAIL",
};

/**
 * Say where a sweep started going wrong.
 *
 * Conditions are reported in the order they were run, never
 * sorted by severity, because their order is the finding: a
 * table that reads pass, pass, fail, fail names a breakpoint,
 * and the same rows sorted worst-first name nothing.
 */
export function renderSweep(
	conditions: readonly Condition[],
	options: { readonly only?: string } = {},
): string {
	if (conditions.length === 0) {
		return renderVerdict(
			{ standing: "warn", headline: "No conditions were swept." },
			"",
		);
	}

	if (options.only) {
		const found = conditions.find(
			(condition) => condition.label === options.only,
		);
		return found
			? found.detail
			: `Nothing was run at '${options.only}'. Ran: ${conditions
					.map((condition) => condition.label)
					.join(", ")}.`;
	}

	const standing = worstOf(conditions.map((condition) => condition.standing));
	const failing = conditions.filter(
		(condition) => condition.standing === "fail",
	);
	const width = Math.max(
		...conditions.map((condition) => condition.label.length),
	);

	const rows = conditions.map(
		(condition) =>
			`  ${condition.label.padEnd(width)}  ${MARK[condition.standing].padEnd(
				4,
			)}  ${condition.headline}`,
	);

	return renderVerdict(
		{
			standing,
			headline: headlineFor(conditions, failing),
			measured: `Ran the same check under ${conditions.length} conditions.`,
		},
		[...rows, "", "Name a condition to see its report in full."].join("\n"),
	);
}

function headlineFor(
	conditions: readonly Condition[],
	failing: readonly Condition[],
): string {
	if (failing.length === 0) {
		const warned = conditions.filter(
			(condition) => condition.standing === "warn",
		);
		return warned.length === 0
			? `Clean under all ${conditions.length} conditions.`
			: `Nothing failed, but ${warned.length} of ${conditions.length} ` +
					"conditions raised something.";
	}
	if (failing.length === conditions.length) {
		return `Fails under all ${conditions.length} conditions.`;
	}
	// Naming the boundary is the point of sweeping at all.
	return `Fails at ${listOf(
		failing.map((condition) => condition.label),
	)}, and passes elsewhere.`;
}

/** Join names the way a person would say them aloud. */
function listOf(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The widths a sweep uses when the caller names none. */
export const DEFAULT_WIDTHS = [375, 768, 1280, 1920] as const;

/** A named condition to run under, ready to apply. */
export interface Sweepable<T> {
	readonly label: string;
	readonly setting: T;
}

/** Turn a list of widths into conditions to sweep. */
export function widthsToSweep(
	widths: readonly number[] = DEFAULT_WIDTHS,
): readonly Sweepable<{ width: number }>[] {
	return widths.map((width) => ({
		label: `${width}px`,
		setting: { width },
	}));
}

/**
 * Read a verdict's standing back out of a rendered report.
 *
 * A report that carries no verdict head reads as "warn", never
 * "pass". This defaulted to pass once, and because two drill-down
 * renderers returned bare prose, a swept rule query reported PASS
 * at every width while the named rule was failing at all of them.
 * Approval is the one answer a parser must never invent: prefer
 * the standing a caller passes as data, and treat this as the
 * fallback for prose we did not produce.
 */
export function standingOf(report: string): Standing {
	if (report.startsWith("FAIL")) return "fail";
	if (report.startsWith("PASS")) return "pass";
	return "warn";
}

/** Read a verdict's headline back out of a rendered report. */
export function headlineOf(report: string): string {
	const first = report.split("\n")[0] ?? "";
	return first.replace(/^(PASS|WARN|FAIL)\s+/, "");
}

/** Build a condition from a rendered report. */
export function conditionFrom(label: string, report: string): Condition {
	return {
		label,
		standing: standingOf(report),
		headline: headlineOf(report),
		detail: report,
	};
}

export type { Verdict };
