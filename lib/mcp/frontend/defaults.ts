import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { truncateForDisplay } from "../content.ts";
import { renderDefaultCall } from "../render/call.ts";
import { CANCELLED_TEXT, renderDefaultResult } from "../render/result.ts";
import type {
	McpContent,
	McpTool,
	McpToolAnnotations,
	McpToolResult,
} from "../types.ts";
import type {
	ConfirmResult,
	FrontEndProvider,
	ResolvedFrontEnd,
} from "./types.ts";

/**
 * Tool-name words, in lower case, that mark a call as state-changing when its
 * annotations carry no read-only or destructive hint. A name is read as words
 * in snake, kebab, camel or Pascal case, with letters and digits apart, so
 * `delete_item`, `delete-item`, `deleteItem`, `Delete_Item` and
 * `v2delete` all hold `delete`. A name run together in lower case, such as
 * `deleteitem` or `setstatus`, is one word, and reads as a read. A word is
 * matched whole, so `settings` isn't `set`, and an undoing or repeating
 * word such as `unarchive` or `redeploy` needs its own entry; only those
 * listed here gate.
 *
 * Many of these are nouns too, so a read named for one asks first:
 * `get_merge_request`, `getPost`, `get_workflow_run`. That costs a
 * confirmation, where a missing word lets a write run unasked, so a word
 * that names a write is listed even when some reads hold it. Words read
 * tools use far more often than writes, such as `schedule` and `resolve`,
 * are left out.
 */
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
	"edit",
	"modify",
	"patch",
	"put",
	"set",
	"unset",
	"upsert",
	"save",
	"merge",
	"commit",
	"revert",
	"rollback",
	"push",
	"fork",
	"import",
	"apply",
	"transition",
	"close",
	"reopen",
	"dismiss",
	"mark",
	"archive",
	"unarchive",
	"publish",
	"unpublish",
	"approve",
	"submit",
	"assign",
	"unassign",
	"invite",
	"share",
	"grant",
	"revoke",
	"transfer",
	"refund",
	"cancel",
	"drop",
	"purge",
	"destroy",
	"execute",
	"exec",
	"run",
	"invoke",
	"trigger",
	"deploy",
	"undeploy",
	"install",
	"uninstall",
	"enable",
	"disable",
	"toggle",
	"lock",
	"unlock",
	"start",
	"stop",
	"pause",
	"restart",
	"restore",
	"reset",
	"kill",
	"terminate",
	"scale",
	"reply",
	"react",
	"reboot",
	"shutdown",
	"truncate",
	"wipe",
	"erase",
	"overwrite",
	"rm",
	"del",
	"rerun",
	"redeploy",
	"retry",
	"resend",
	"reassign",
	"rebase",
	"confirm",
	"void",
	"charge",
	"migrate",
	"upgrade",
	"subscribe",
	"unsubscribe",
	"follow",
	"unfollow",
	"star",
	"unstar",
	"pin",
	"unpin",
	"attach",
	"detach",
	"resume",
	"unpause",
	"reject",
	"decline",
	"deny",
	"accept",
	"rotate",
	"checkout",
	"init",
	"suspend",
	"clone",
	"duplicate",
	"mute",
	"unmute",
	"unshare",
	"reinstall",
	"rewrite",
	"resubmit",
	"republish",
	"recreate",
	"flush",
	"prune",
	"drain",
	"evict",
	"acknowledge",
	"kick",
	"ban",
]);

/**
 * Where one word of a tool name ends: a run of anything but letters and
 * digits, a lower-case letter or digit before a capital, the last capital of
 * a run before a capital and a lower-case letter, or a letter beside a digit.
 */
const WORD_BREAK =
	/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/;

/** The words of a tool name, in lower case, whether it is spelt in snake, kebab, camel or Pascal case. */
function nameWords(name: string): string[] {
	return name
		.split(WORD_BREAK)
		.filter((word) => word !== "")
		.map((word) => word.toLowerCase());
}

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
 * Annotations decide it when they carry a read-only or destructive hint. A
 * read-only hint decides alone: true never gates, false always does. A
 * destructive hint of either value without one gates, since the MCP spec
 * gives a destructive hint meaning only for a tool that isn't read only, so
 * a server sending one describes a write; false says it only adds, such as
 * a post. With neither hint, whether the
 * server sent no annotations or ones carrying neither, the tool name's words
 * are checked against the write verbs, so an empty annotation can't wave a
 * `delete_` tool past the gate in any of the cases `WRITE_VERBS` reads. A
 * server can still name a write with no listed word, or call it read only,
 * so this guards against a careless server, not a hostile one.
 */
export function defaultWriteSignal(tool: McpTool): boolean {
	const none: McpToolAnnotations = {};
	const { readOnlyHint, destructiveHint } = tool.annotations ?? none;
	if (typeof readOnlyHint === "boolean") return !readOnlyHint;
	if (typeof destructiveHint === "boolean") return true;
	return nameWords(tool.name).some((word) => WRITE_VERBS.has(word));
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
			renderDefaultCall(
				context.tool,
				args,
				theme,
				{
					multiServer: context.serverCount > 1,
					serverLabel: context.tool.serverId,
				},
				context.lastComponent,
			),
		renderResult: (result, options, theme, context) =>
			renderDefaultResult(result, options, theme, context),
		wrap: makeDefaultWrap(opts),
	};
}
