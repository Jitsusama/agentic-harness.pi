/**
 * How verification's fix request looks in the transcript.
 *
 * The model reads the whole request as text. The person reads one
 * narration line, the same `※` line every harness note uses, saying
 * how many errors in how many files, with the list itself behind the
 * expand key. The footer's mark already says it is failing and how
 * many attempts are spent, so the line says neither.
 */

import { relative } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { count } from "../../lib/ui/count.ts";
import { renderNarrationLine } from "../../lib/ui/narration.ts";
import type { FileError } from "../../lib/verification/index.ts";

/** The custom message type verification's fix request goes out as. */
export const VERIFICATION_MESSAGE = "verification";

/** What a fix request carries for drawing it, beside the text the model reads. */
export interface VerificationReport {
	readonly errors: readonly FileError[];
}

const INDENT = "  ";

/** Whether a message's details are a verification report. */
export function isVerificationReport(
	details: unknown,
): details is VerificationReport {
	if (typeof details !== "object" || details === null) return false;
	const errors = (details as { errors?: unknown }).errors;
	return Array.isArray(errors);
}

/** The lines a fix request draws: one, or the errors too when expanded. */
export function verificationLines(
	report: VerificationReport,
	theme: Theme,
	width: number,
	expanded: boolean,
	cwd: string = process.cwd(),
): string[] {
	const files = new Set(report.errors.map((error) => error.path)).size;
	const header = renderNarrationLine(
		"verify",
		`${count(report.errors.length, "error")} in ${count(files, "file")}`,
		theme,
		{ level: "error" },
	);
	const lines = [truncateToWidth(header, width)];
	if (!expanded) return lines;
	for (const error of report.errors) {
		const where = `${shown(error.path, cwd)}:${error.line}:${error.character}`;
		lines.push(
			truncateToWidth(
				`${INDENT}${theme.fg("muted", where)} ${theme.fg("dim", error.message)}`,
				width,
			),
		);
	}
	return lines;
}

/** A path as short as it can be said: from the session's directory when under it. */
function shown(path: string, cwd: string): string {
	const near = relative(cwd, path);
	return near && !near.startsWith("..") ? near : path;
}
