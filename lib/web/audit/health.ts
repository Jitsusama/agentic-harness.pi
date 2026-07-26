/**
 * One question that asks all the others.
 *
 * A person who has just changed something wants to know whether
 * they broke anything, and does not want to run five checks to
 * find out. This composes them into one answer: the worst
 * standing across all of them, a line each, and the detail left
 * behind a named kind.
 *
 * The digest deliberately reports what it could not run. A check
 * that failed to execute is not a check that passed, and a
 * digest that quietly drops one is worse than no digest, because
 * it looks like coverage.
 */

import type { Standing } from "./verdict.js";
import { renderVerdict } from "./verdict.js";

/** One check's contribution to the digest. */
export interface Part {
	readonly kind: string;
	readonly standing: Standing;
	readonly headline: string;
	/** Set when the check could not run at all. */
	readonly failedToRun?: string;
}

const MARK: Readonly<Record<Standing, string>> = {
	pass: "pass",
	warn: "warn",
	fail: "FAIL",
};

/** The worst standing among the parts. */
export function overallOf(parts: readonly Part[]): Standing {
	if (parts.some((part) => part.standing === "fail")) return "fail";
	return parts.some((part) => part.standing === "warn") ? "warn" : "pass";
}

/** Say how the page is doing, across every check. */
export function renderHealth(parts: readonly Part[]): string {
	if (parts.length === 0) {
		return renderVerdict(
			{ standing: "warn", headline: "No checks were run." },
			"",
		);
	}

	const width = Math.max(...parts.map((part) => part.kind.length));
	const lines = parts.map(
		(part) =>
			`  ${part.kind.padEnd(width)}  ${MARK[part.standing].padEnd(4)}  ` +
			part.headline,
	);

	const broken = parts.filter((part) => part.failedToRun);
	const failing = parts.filter((part) => part.standing === "fail");
	const warning = parts.filter((part) => part.standing === "warn");

	return renderVerdict(
		{
			standing: overallOf(parts),
			headline: headlineFor(failing, warning),
			measured:
				broken.length === 0
					? `Ran ${parts.length} checks.`
					: `Ran ${parts.length - broken.length} of ${parts.length} checks; ` +
						`${broken.map((part) => part.kind).join(", ")} could not run.`,
		},
		[...lines, "", "Name a kind to run just that one in full."].join("\n"),
	);
}

function headlineFor(
	failing: readonly Part[],
	warning: readonly Part[],
): string {
	if (failing.length > 0) {
		return `${failing.map((part) => part.kind).join(", ")} ${
			failing.length === 1 ? "fails" : "fail"
		}.`;
	}
	if (warning.length > 0) {
		return `Nothing fails, but ${warning
			.map((part) => part.kind)
			.join(", ")} raised something.`;
	}
	return "Everything checks out.";
}
