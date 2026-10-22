/**
 * How guard reports and the guard table are drawn.
 *
 * Pure functions from data and a theme to lines, so the transcript
 * entry and the `/guards` panel can be measured in tests.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { GuardReport, ResolvedGuard } from "../../lib/guardian/index.ts";
import type { GuardianOutcome } from "../../lib/internal/guardian/registry.ts";
import { footerMark, type MarkTheme } from "../../lib/ui/footer-mark.ts";
import { renderMarkdown, renderNarrationLine } from "../../lib/ui/index.ts";

/** Body lines a collapsed report shows before it says how many are left. */
export const COLLAPSED_BODY_LINES = 12;

const INDENT = "  ";

const KIND_VERB: Record<GuardReport["kind"], string> = {
	shown: "reported",
	waved: "let through",
	overridden: "overridden by the agent",
	fixed: "fixed",
	held: "held for your return",
};

/**
 * A report as transcript lines: a header naming the guard and what it
 * did, the body as markdown, then the notes. Collapsed, a long body
 * stops after {@link COLLAPSED_BODY_LINES} and says how much is left.
 */
export function guardReportLines(
	report: GuardReport,
	theme: Theme,
	width: number,
	expanded: boolean,
): string[] {
	const header = renderNarrationLine(
		`${report.guard} guard`,
		`${KIND_VERB[report.kind]}: ${report.title}`,
		theme,
		{
			level:
				report.kind === "waved" || report.kind === "overridden"
					? "warn"
					: "info",
		},
	);
	const lines = [truncateToWidth(header, width)];
	const inner = Math.max(1, width - INDENT.length);

	if (report.body) {
		const body = renderMarkdown(report.body, theme, inner);
		const shown =
			expanded || body.length <= COLLAPSED_BODY_LINES
				? body
				: body.slice(0, COLLAPSED_BODY_LINES);
		for (const line of shown) lines.push(`${INDENT}${line}`);
		const hidden = body.length - shown.length;
		if (hidden > 0) {
			lines.push(
				truncateToWidth(
					`${INDENT}${theme.fg("dim", `${hidden} more lines; expand tool output to read them`)}`,
					width,
				),
			);
		}
	}

	if (report.notes && report.notes.length > 0) {
		lines.push(
			truncateToWidth(
				`${INDENT}${theme.fg("dim", report.notes.join(" · "))}`,
				width,
			),
		);
	}
	return lines;
}

/** The last outcome a guard's registry entry recorded, as a short word. */
function outcomeWord(outcome: GuardianOutcome | undefined): string {
	if (!outcome) return "";
	switch (outcome.kind) {
		case "allowed":
			return "last: allowed";
		case "blocked":
			return "last: blocked";
		case "rewritten":
			return "last: rewritten";
		case "skipped":
			return `last: skipped (${outcome.why})`;
	}
}

/**
 * The footer's mark for this session's overrides, or undefined when
 * there are none.
 *
 * It says only that overrides are in force: a flag, and a count once
 * there is more than one. Which guards, and in what mode, is one step
 * away in `/guards`, where every row already says it came from the
 * session. The flag stays muted, since the person set these themselves
 * and nothing here wants their attention.
 */
export function overridesMark(
	modes: Readonly<Record<string, unknown>>,
	theme: MarkTheme,
): string | undefined {
	const count = Object.keys(modes).length;
	if (count === 0) return undefined;
	return footerMark("overridden", "muted", theme, count);
}

const MODE_COLOUR = {
	off: "muted",
	redirect: "success",
	block: "warning",
} as const;

/**
 * Every guard as one row: name, class, mode and where the mode came
 * from, then what it last did when the pipeline records that.
 */
export function guardTableLines(
	guards: readonly ResolvedGuard[],
	outcomes: ReadonlyMap<string, GuardianOutcome | undefined>,
	theme: Theme,
	width: number,
): string[] {
	if (guards.length === 0) {
		return ["", theme.fg("muted", "  No guards declared."), ""];
	}
	const nameWidth = Math.max(...guards.map((g) => g.declaration.name.length));
	const classWidth = Math.max(...guards.map((g) => g.declaration.class.length));
	const lines = [""];
	for (const guard of guards) {
		const { name, description } = guard.declaration;
		const mode = theme.fg(MODE_COLOUR[guard.mode], guard.mode.padEnd(8));
		const source = theme.fg("dim", guard.source.padEnd(7));
		const outcome = outcomeWord(outcomes.get(name));
		lines.push(
			truncateToWidth(
				`  ${theme.fg("text", name.padEnd(nameWidth))}  ${theme.fg("muted", guard.declaration.class.padEnd(classWidth))}  ${mode} ${source}${outcome ? `  ${theme.fg("dim", outcome)}` : ""}`,
				width,
			),
		);
		if (description) {
			lines.push(
				truncateToWidth(
					`  ${" ".repeat(nameWidth)}  ${theme.fg("dim", description)}`,
					width,
				),
			);
		}
	}
	lines.push(
		"",
		truncateToWidth(
			theme.fg(
				"dim",
				"  /guards <name|group|class|all> <off|redirect|block> sets this session; /guards reset clears it.",
			),
			width,
		),
		"",
	);
	return lines;
}
