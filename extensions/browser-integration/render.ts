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
 */

import type {
	AgentToolResult,
	ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { BrowserDetails } from "./result.js";

/**
 * The colouring surface a renderer is handed.
 *
 * Pi exports the concrete Theme from an internal path rather
 * than from either package root, so the two calls used here are
 * declared structurally instead of reaching into its internals.
 */
interface Theme {
	fg(role: string, text: string): string;
	bold(text: string): string;
}

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

/** How much of a long argument to show before cutting it. */
const MAX_ARGUMENT = 48;

function clip(value: string): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= MAX_ARGUMENT
		? flat
		: `${flat.slice(0, MAX_ARGUMENT)}...`;
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
	let line = theme.fg("toolTitle", theme.bold(`browser ${verb}`));

	if (call.kind) line += ` ${call.kind}`;

	const subject = subjectOf(call);
	if (subject) line += theme.fg("dim", ` ${clip(subject)}`);

	if (call.widths && call.widths.length > 0) {
		line += theme.fg("dim", ` across ${call.widths.length} widths`);
	}
	if (call.at) line += theme.fg("dim", ` at ${call.at}`);

	// The session only earns space when it is not the only one.
	if (call.session && call.session !== "default") {
		line += theme.fg("dim", ` [${call.session}]`);
	}

	return new Text(line);
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

	if (options.expanded) return new Text(content);

	if (meta.ok === false) {
		return new Text(theme.fg("warning", `refused: ${firstLine(content)}`));
	}

	const head = firstLine(content);
	const verdict = VERDICTS.find((mark) => head.startsWith(mark));
	if (!verdict) return new Text(theme.fg("dim", head));

	const colour =
		verdict === "FAIL" ? "error" : verdict === "WARN" ? "warning" : "success";
	const rest = head.slice(verdict.length).trim();
	return new Text(`${theme.fg(colour, theme.bold(verdict))} ${rest}`);
}

function firstLine(content: string): string {
	const line = content.split("\n").find((one) => one.trim() !== "") ?? "";
	return line.length <= 120 ? line : `${line.slice(0, 120)}...`;
}
