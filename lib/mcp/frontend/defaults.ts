import type { AgentToolResult } from "@mariozechner/pi-coding-agent";
import { truncateForDisplay } from "../content.js";
import { renderDefaultCall } from "../render/call.js";
import { CANCELLED_TEXT, renderDefaultResult } from "../render/result.js";
import type { McpContent, McpTool, McpToolResult } from "../types.js";
import type {
	ConfirmResult,
	FrontEndProvider,
	ResolvedFrontEnd,
} from "./types.js";

/** Tool-name tokens that mark a call as state-changing when a server ships no annotations. */
export const WRITE_VERBS = new Set([
	"create",
	"update",
	"delete",
	"write",
	"append",
	"clear",
	"insert",
	"replace",
	"add",
	"remove",
	"send",
	"post",
	"move",
	"rename",
	"escalate",
	"comment",
	"upload",
]);

/** The default shaper: hand the model exactly what the server returned. */
export function identityShape(result: McpToolResult): McpContent[] {
	return result.content;
}

/**
 * A shaper that caps each text block to the given limits and appends a
 * truncation marker, leaving short blocks and non-text content untouched. A
 * server installs this to keep model-facing output token-conscious.
 */
export function makeTruncatingShape(limits: {
	maxLines: number;
	maxBytes: number;
}) {
	return (result: McpToolResult): McpContent[] =>
		result.content.map((block) => {
			if (block.type !== "text") return block;
			const { text, truncated, shownLines, totalLines } = truncateForDisplay(
				block.text,
				limits,
			);
			if (!truncated) return block;
			return {
				type: "text",
				text: `${text}\n\n[Truncated: ${shownLines} of ${totalLines} lines shown.]`,
			};
		});
}

/**
 * Whether a call should pass through a write gate.
 *
 * Annotations decide it when present: a read-only tool never gates, and a
 * destructive or explicitly non-read-only tool always does. With no
 * annotations, the tool name is checked against the write-verb tokens.
 */
export function defaultWriteSignal(tool: McpTool): boolean {
	const annotations = tool.annotations;
	if (annotations) {
		if (annotations.readOnlyHint === true) return false;
		return (
			annotations.destructiveHint === true || annotations.readOnlyHint === false
		);
	}
	return tool.name.split("_").some((token) => WRITE_VERBS.has(token));
}

/** Convert a server result into the text and image content pi carries to the model. */
export function toAgentContent(
	result: McpToolResult,
): AgentToolResult<unknown>["content"] {
	const out: AgentToolResult<unknown>["content"] = [];
	for (const block of result.content) {
		if (block.type === "text") out.push({ type: "text", text: block.text });
		else if (block.type === "image")
			out.push({ type: "image", data: block.data, mimeType: block.mimeType });
		else if (block.type === "resource_link")
			out.push({ type: "text", text: `[resource: ${block.uri}]` });
	}
	return out;
}

/**
 * The default execution wrapper. Non-write calls pass straight through. A write
 * runs the injected gate first: cancel returns the cancel sentinel, a redirect
 * returns the note for the model to act on, and approval invokes with the
 * (possibly edited) args. The transport-shaped result is returned unchanged;
 * the core shapes and converts it afterwards.
 */
export function makeDefaultWrap(opts: {
	writeSignal: (tool: McpTool) => boolean;
	showGate?: (
		tool: McpTool,
		args: Record<string, unknown>,
	) => Promise<ConfirmResult<Record<string, unknown>>>;
}): NonNullable<FrontEndProvider["wrap"]> {
	return (invoke, tool) => async (args, _ctx, signal) => {
		let effectiveArgs = args;
		if (opts.writeSignal(tool) && opts.showGate) {
			const decision = await opts.showGate(tool, args);
			if (decision === null)
				return { content: [{ type: "text", text: CANCELLED_TEXT }] };
			if (!decision.approved)
				return {
					content: [{ type: "text", text: `Redirected: ${decision.redirect}` }],
				};
			effectiveArgs = decision.data;
		}
		return invoke(effectiveArgs, signal);
	};
}

/** Assemble the core default hooks, closing over the write signal and gate. */
export function defaultResolved(opts: {
	writeSignal: (tool: McpTool) => boolean;
	showGate?: (
		tool: McpTool,
		args: Record<string, unknown>,
	) => Promise<ConfirmResult<Record<string, unknown>>>;
}): ResolvedFrontEnd {
	return {
		shape: identityShape,
		renderCall: (args, theme, context) =>
			renderDefaultCall(context.tool, args, theme, {
				multiServer: context.serverCount > 1,
				serverLabel: context.tool.serverId,
			}),
		renderResult: (result, options, theme, context) =>
			renderDefaultResult(result, options, theme, context),
		wrap: makeDefaultWrap(opts),
	};
}
