import type { Theme } from "@mariozechner/pi-coding-agent";
import { type Component, Text } from "@mariozechner/pi-tui";
import type { McpTool } from "../types.js";

/** The view-model for a default tool-call line, independent of styling. */
export interface CallView {
	toolTitle: string;
	serverPrefix?: string;
	primaryArg?: { name: string; value: string };
	extraArgCount: number;
}

/** Longest primary-argument value shown before it is ellipsised. */
export const MAX_PRIMARY_VALUE = 40;

/** Argument names that read as the subject of a call when no required string arg exists. */
const CONVENTIONAL_ARGS = [
	"query",
	"q",
	"path",
	"url",
	"name",
	"id",
	"text",
	"prompt",
	"command",
	"pattern",
];

/**
 * Compute what a default call line shows: the tool title, the primary argument
 * (first required string, else a conventional name present in the args), the
 * count of remaining arguments, and a server prefix only when more than one
 * server is mounted.
 */
export function describeCall(
	tool: McpTool,
	args: Record<string, unknown>,
	opts: { multiServer?: boolean; serverLabel?: string } = {},
): CallView {
	const keys = Object.keys(args);
	const name = primaryArgName(tool, args);
	const primaryArg =
		name !== undefined
			? { name, value: truncate(stringify(args[name]), MAX_PRIMARY_VALUE) }
			: undefined;

	return {
		toolTitle: tool.name,
		serverPrefix: opts.multiServer
			? (opts.serverLabel ?? tool.serverId)
			: undefined,
		primaryArg,
		extraArgCount: keys.length - (primaryArg ? 1 : 0),
	};
}

/** Render the default call line as a single styled row. */
export function renderDefaultCall(
	tool: McpTool,
	args: Record<string, unknown>,
	theme: Theme,
	opts: { multiServer?: boolean; serverLabel?: string } = {},
): Component {
	const view = describeCall(tool, args, opts);
	const prefix = view.serverPrefix
		? theme.fg("muted", `[${view.serverPrefix}] `)
		: "";
	const title = theme.fg("toolTitle", theme.bold(view.toolTitle));
	const primary = view.primaryArg
		? ` ${theme.fg("dim", view.primaryArg.value)}`
		: "";
	const extra =
		view.extraArgCount > 0
			? theme.fg("muted", ` +${view.extraArgCount} args`)
			: "";
	return new Text(`${prefix}${title}${primary}${extra}`, 0, 0);
}

function primaryArgName(
	tool: McpTool,
	args: Record<string, unknown>,
): string | undefined {
	const properties = tool.inputSchema.properties ?? {};
	const required = tool.inputSchema.required ?? [];
	for (const key of required) {
		if (isStringProp(properties[key]) && key in args) return key;
	}
	for (const key of CONVENTIONAL_ARGS) {
		if (key in args) return key;
	}
	return undefined;
}

function isStringProp(prop: unknown): boolean {
	return (
		typeof prop === "object" &&
		prop !== null &&
		(prop as { type?: unknown }).type === "string"
	);
}

function stringify(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
