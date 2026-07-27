/**
 * Reporting what the page cost.
 */

import { renderVerdict, type Standing } from "../audit/verdict.js";

import {
	type Measure,
	type Rating,
	type Vitals,
	worstShiftSources,
} from "./vitals.js";

const MARK: Readonly<Record<Rating, string>> = {
	good: "good",
	"needs-improvement": "near",
	poor: "POOR",
};

/** Mildest to worst, for ordering what to look at first. */
const SEVERITY: readonly Rating[] = ["good", "needs-improvement", "poor"];

/** The worst rating decides the verdict. */
function overall(measures: readonly Measure[]): Standing {
	if (measures.some((one) => one.rating === "poor")) return "fail";
	return measures.some((one) => one.rating === "needs-improvement")
		? "warn"
		: "pass";
}

function say(value: number, unit: Measure["unit"]): string {
	return unit === "ms" ? `${Math.round(value)} ms` : value.toFixed(3);
}

/** Say what the page cost, and what to look at first. */
export function renderVitals(
	vitals: Vitals,
	measures: readonly Measure[],
): string {
	if (vitals.error) {
		return renderVerdict(
			{
				standing: "warn",
				headline: "The performance observers could not be installed.",
				measured: vitals.error,
			},
			"",
		);
	}
	if (measures.length === 0) {
		return renderVerdict(
			{
				standing: "warn",
				headline: "Nothing was measured.",
				measured:
					"Observers are installed when a page opens, so a session " +
					"that has not navigated since has nothing to report.",
			},
			"",
		);
	}

	// Some measures arrived and some observers did not install. Say
	// both, rather than throwing away what was collected: one
	// unsupported entry type used to cost the whole report.
	const missing = vitals.unavailable ?? [];

	// Naming the one that is never taken, rather than leaving a
	// count to imply the set. Interaction to next paint needs a
	// person to interact: nothing here observes event timing, so a
	// reader told only that four were measured has no way to know
	// responsiveness was never among them, and assumes it passed.
	const caveat =
		` Interaction to next paint is not among them: it needs an ` +
		`interaction, and this measures a load.` +
		(missing.length === 0 ? "" : ` Not observed: ${missing.join("; ")}.`);
	const width = Math.max(...measures.map((one) => one.name.length));
	const lines = measures.map(
		(one) =>
			`  ${one.name.padEnd(width)}  ${MARK[one.rating].padEnd(4)}  ` +
			`${say(one.value, one.unit).padStart(9)}` +
			`${one.detail ? `  ${one.detail}` : ""}`,
	);

	const blame = worstShiftSources(vitals.shifts);
	if (blame.length > 0) {
		lines.push("", "What moved the page:");
		for (const source of blame) {
			lines.push(`  ${source.node}  ${source.moved.toFixed(3)}`);
		}
	}

	// Worst first, so naming failing[0] names the worst thing.
	// Sorting the other way put a near-miss ahead of a failure and
	// the headline pointed at the milder of the two.
	const failing = measures
		.filter((one) => one.rating !== "good")
		.sort((a, b) => SEVERITY.indexOf(b.rating) - SEVERITY.indexOf(a.rating));

	return renderVerdict(
		{
			// A partial capture cannot pass: an observer that never
			// installed reports nothing, which reads the same as a page
			// with nothing wrong.
			standing:
				missing.length > 0 && overall(measures) === "pass"
					? "warn"
					: overall(measures),
			headline:
				failing.length === 0
					? missing.length === 0
						? "Every measure is within its threshold."
						: "Every measure taken is within its threshold, but " +
							`${missing.length} could not be observed.`
					: `${failing.length} of ${measures.length} measures are outside ` +
						`their threshold, worst is ${failing[0]?.name}.`,
			measured: `Measured ${measures.length} of the published web vitals.${caveat}`,
		},
		lines.join("\n"),
	);
}
