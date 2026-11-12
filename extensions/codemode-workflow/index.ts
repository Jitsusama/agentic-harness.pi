/**
 * Codemode Workflow: a script still running after a minute moves to the
 * background, as a long bash command does.
 *
 * A codemode script holds the session until it ends, and pi steers the
 * person's and the mesh's messages in only between calls. On 11 November
 * 270 scripts held their sessions past a minute, at the median for two
 * and a half minutes and the longest for seven and a half hours. Most
 * were loops of short bash calls and mesh reads waiting on something,
 * which slip past bash's own hand-off, since a call a script makes must
 * answer the script.
 *
 * The tool is pi's own codemode, its sandbox, loadout and rendering
 * untouched, registered under its own name before pi's built-in, which
 * the first registration of a name shadows. Only the call's wait is
 * this extension's. In a run that ends with its prompts (print and JSON
 * mode, as subagents run) nothing hands off, since nobody would hear
 * the result.
 */

import {
	createCodemodeExtension,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { sessionKeyOf } from "../../lib/core/session/index.ts";
import {
	endsWithItsPrompts,
	HAND_OFF_MS,
	runOrHandOff,
	spoken,
} from "../../lib/jobs/hand-off.ts";

/** pi's codemode, as its built-in extension would register it here. */
function piCodemode(pi: ExtensionAPI): ToolDefinition | undefined {
	let found: ToolDefinition | undefined;
	const capturing = new Proxy(pi, {
		get(target, key) {
			if (key === "registerTool") {
				return (tool: ToolDefinition) => {
					found = tool;
				};
			}
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	createCodemodeExtension()(capturing);
	return found;
}

/** Longest label a script's job is given. */
const LABEL_CHARS = 60;

/** A script, named in a line: its first line that says something. */
export function scriptLabel(code: string): string {
	const said = code
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line !== "" && !line.startsWith("// @options"));
	const line = said ?? "a script";
	return line.length <= LABEL_CHARS
		? line
		: `${line.slice(0, LABEL_CHARS - 3)}...`;
}

/** The script a call runs, when its arguments say one. */
function codeOf(params: unknown): string {
	if (typeof params !== "object" || params === null) return "";
	if (!("code" in params)) return "";
	return typeof params.code === "string" ? params.code : "";
}

export default function codemodeWorkflow(pi: ExtensionAPI) {
	const codemode = piCodemode(pi);
	if (!codemode) return;
	pi.registerTool({
		...codemode,
		promptGuidelines: [
			...(codemode.promptGuidelines ?? []),
			`A script still running after ${spoken(HAND_OFF_MS)} moves to the background, and its result arrives later as a message of its own, so do not write a script that waits in a loop for something: start the work and carry on.`,
		],
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const code = codeOf(params);
			return await runOrHandOff({
				kind: "codemode",
				label: scriptLabel(code),
				noun: "background script",
				filePrefix: "pi-codemode",
				stopping: (jobId) =>
					`To stop it, call the jobs tool's stop with ${jobId} (load it with tool_search). The person can stop it with /jobs.`,
				quiet: "It has shown nothing yet.",
				toolCallId,
				session: sessionKeyOf(ctx),
				nested: endsWithItsPrompts(ctx.mode),
				signal,
				onUpdate,
				bus: pi.events,
				run: (owned, update) =>
					codemode.execute(toolCallId, params, owned, update, ctx),
			});
		},
	});
}
