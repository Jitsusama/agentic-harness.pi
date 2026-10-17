import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { count } from "../../ui/count.ts";
import { asText, renderToolCall } from "../../ui/tool-call.ts";
import type { McpTool } from "../types.ts";

/** The view-model for a default tool-call line, independent of styling. */
export interface CallView {
	toolTitle: string;
	serverPrefix?: string;
	primaryArg?: { name: string; value: string };
	extraArgCount: number;
}

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
		name !== undefined ? { name, value: stringify(args[name]) } : undefined;

	return {
		toolTitle: tool.name,
		serverPrefix: opts.multiServer
			? (opts.serverLabel ?? tool.serverId)
			: undefined,
		primaryArg,
		extraArgCount: keys.length - (primaryArg ? 1 : 0),
	};
}

/**
 * Render the default call line as the harness's one call line: the tool
 * bold, then its subject and notes dim, clipped where every other tool's
 * is. It drew its own shape, a server in brackets ahead of the tool and
 * a 40-column clip, so a gateway's tools read unlike the ones beside
 * them; the server now follows as a note, since the tool is the anchor.
 *
 * Pass pi's previous component as `reuse`, so a redraw updates it rather
 * than leaving it beside its replacement.
 */
export function renderDefaultCall(
	tool: McpTool,
	args: Record<string, unknown>,
	theme: Theme,
	opts: { multiServer?: boolean; serverLabel?: string } = {},
	reuse?: unknown,
): Component {
	const view = describeCall(tool, args, opts);
	const notes = [
		...(view.extraArgCount > 0 ? [`+${count(view.extraArgCount, "arg")}`] : []),
		...(view.serverPrefix ? [`on ${view.serverPrefix}`] : []),
	];
	return renderToolCall(
		{ tool: view.toolTitle, subject: view.primaryArg?.value, notes },
		theme,
		asText(reuse),
	);
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
