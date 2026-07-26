/**
 * How a query reads in the transcript.
 *
 * A query is two short facts: what was asked, and how much came
 * back. Both fit on one line, so the collapsed view is one line
 * and the expanded view adds the matches themselves.
 *
 * Text is built with (0, 0) throughout: pi already wraps every
 * tool row in a padded box, and taking the default pads it twice.
 */

import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { QueryDetails } from "./index.js";

/** How much of an expression is shown before it is clipped. */
const MAX_EXPRESSION_SHOWN = 60;

/** The call, as one line: the expression and the handle it ran against. */
export function renderQueryCall(args: unknown, theme: Theme): Text {
	const params = args as { handle?: string; expression?: string };
	const label = theme.fg("toolTitle", theme.bold("result_query "));
	const expression = theme.fg("dim", clip(params.expression ?? ""));
	const handle = theme.fg("dim", ` on ${params.handle ?? "?"}`);
	return new Text(label + expression + handle, 0, 0);
}

/** The result: the match count, and the matches when expanded. */
export function renderQueryResult(
	result: AgentToolResult<unknown>,
	state: { expanded: boolean },
	theme: Theme,
): Text {
	// Pi types details as unknown at the render seam. Reading back
	// what this tool itself wrote is the sanctioned cast.
	const details = result.details as QueryDetails | undefined;
	const blocks = (result.content ?? [])
		.filter((block): block is { type: "text"; text: string } => {
			return block.type === "text";
		})
		.map((block) => block.text);

	// A query that could not run says why in its only block, and that
	// sentence is the whole answer rather than a summary of one.
	if (details?.matches === undefined) {
		return new Text(theme.fg("warning", blocks.join("\n")), 0, 0);
	}

	const summary = theme.fg(
		"success",
		`${details.matches} ${details.matches === 1 ? "match" : "matches"}`,
	);
	if (!state.expanded) return new Text(summary, 0, 0);
	return new Text(`${summary}\n${blocks.slice(1).join("\n")}`, 0, 0);
}

/** Keep a caller's expression from taking over the line. */
function clip(expression: string): string {
	return expression.length > MAX_EXPRESSION_SHOWN
		? `${expression.slice(0, MAX_EXPRESSION_SHOWN)}...`
		: expression;
}
