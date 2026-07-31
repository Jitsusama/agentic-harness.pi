/**
 * How the four browser tools read in the transcript.
 *
 * A tool call is a line somebody skims while waiting, so each
 * one says the verb, the thing it acted on, and nothing else.
 * "browser see element navigation Main" is legible at a glance;
 * a serialized parameter object is not, and it is the same
 * information.
 *
 * Results are summarised to their first meaningful line, with
 * the verdict mark kept when there is one. A check that says
 * FAIL should still say FAIL when it is collapsed, since that is
 * the whole reason somebody scrolls back.
 *
 * Every Text here is built with padding (0, 0). Text defaults to
 * one column and one row of padding, and pi already wraps a tool
 * row in a Box that pads it, so accepting the default pads the
 * same content twice: a blank line above and below every call
 * and every result, which turns a transcript of short lines into
 * mostly empty screen. This is the one rule in pi's own
 * rendering best practices that costs nothing to follow and is
 * invisible until somebody screenshots the terminal.
 */

import type {
	AgentToolResult,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type RenderTheme, renderToolCall } from "../../lib/ui/index.js";
import type { BrowserDetails } from "./result.js";

/**
 * The colouring surface a renderer is handed.
 *
 * Declared structurally because pi exports the concrete Theme from an internal
 * path rather than from either package root. This file had its own copy until
 * three surfaces wanted the same call line and the declaration moved to `lib/ui`
 * with it, so the alias is what is left: one definition, named where it is used.
 */
type Theme = RenderTheme;

/** Everything any of the four tools might be called with. */
interface CallArgs {
	kind?: string;
	session?: string;
	url?: string;
	within?: string;
	role?: string;
	name?: string;
	action?: string;
	text?: string;
	keys?: string;
	expression?: string;
	rule?: string;
	baseline?: string;
	tag?: string;
	widths?: number[];
	at?: string;
	filter?: string;
	for?: string;
	device?: string;
	throttle?: string;
	mock?: string;
	block?: string;
}

/**
 * The most useful thing to say about a call after its kind.
 *
 * One subject per call, chosen by what the kind is actually
 * about, rather than every argument that happened to be set.
 */
function subjectOf(args: CallArgs): string | undefined {
	if (args.url) return args.url;
	if (args.device) return args.device;
	if (args.throttle) return args.throttle;
	if (args.mock) return `mock ${args.mock}`;
	if (args.block) return `block ${args.block}`;
	if (args.role) return [args.role, args.name].filter(Boolean).join(" ");
	if (args.expression) return args.expression;
	if (args.keys) return args.keys;
	if (args.text) return `"${args.text}"`;
	if (args.for) return args.for;
	if (args.within) return args.within;
	if (args.rule) return args.rule;
	if (args.tag) return args.tag;
	if (args.baseline) return args.baseline;
	if (args.filter) return args.filter;
	return undefined;
}

/** Draw one browser tool call as a single readable line. */
export function renderBrowserCall(
	verb: string,
	args: unknown,
	theme: Theme,
): Text {
	const call = (args ?? {}) as CallArgs;
	const subject = subjectOf(call);

	// This shape was the one the other two surfaces were measured against and
	// found wanting, so it moved to `lib/ui` rather than being copied twice. It
	// draws the same as it always did; what changed is that three tools now share
	// one implementation instead of three that happen to agree.
	return renderToolCall(
		{
			tool: `browser ${verb}`,
			...(call.kind ? { action: call.kind } : {}),
			...(subject ? { subject } : {}),
			notes: [
				...(call.widths && call.widths.length > 0
					? [`across ${call.widths.length} widths`]
					: []),
				...(call.at ? [`at ${call.at}`] : []),
				// The session only earns space when it is not the only one.
				...(call.session && call.session !== "default"
					? [`[${call.session}]`]
					: []),
			],
		},
		theme,
	);
}

/** The verdict marks a check may open with. */
const VERDICTS = ["PASS", "WARN", "FAIL"] as const;

/**
 * Draw the result, keeping the verdict when there is one.
 *
 * Collapsed, a reader gets the standing and the headline, which
 * is what they scrolled back for. Expanded, they get the report
 * as the tool wrote it, because every one of those was built to
 * be read whole.
 */
export function renderBrowserResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Text {
	// Pi types details as unknown at the render seam. Reading back
	// what these tools themselves wrote is the sanctioned cast.
	const meta = (result.details ?? {}) as Partial<BrowserDetails>;
	const content = result.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");

	if (options.expanded) return new Text(content, 0, 0);

	// Which session answered, when it is not the obvious one. The
	// call line can only show what was passed, so a call that named
	// no session showed none, even when the tool had resolved it to
	// the only one open. Reading a verdict without knowing which page
	// it judged is how the wrong page gets fixed.
	const where =
		meta.session && meta.session !== "default"
			? theme.fg("dim", `[${meta.session}] `)
			: "";

	if (meta.ok === false) {
		return new Text(
			`${where}${theme.fg("warning", `refused: ${firstLine(content)}`)}`,
			0,
			0,
		);
	}

	const head = firstLine(content);
	const verdict = VERDICTS.find((mark) => head.startsWith(mark));
	if (!verdict) return new Text(`${where}${theme.fg("dim", head)}`, 0, 0);

	const colour =
		verdict === "FAIL" ? "error" : verdict === "WARN" ? "warning" : "success";
	const rest = head.slice(verdict.length).trim();
	return new Text(
		`${where}${theme.fg(colour, theme.bold(verdict))} ${rest}`,
		0,
		0,
	);
}

function firstLine(content: string): string {
	const line = content.split("\n").find((one) => one.trim() !== "") ?? "";
	return line.length <= 120 ? line : `${line.slice(0, 120)}...`;
}
