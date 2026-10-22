/**
 * Edit Escape Interceptor Extension
 *
 * Reads a `\uXXXX` escape in an edit as the character it names, when the
 * file shows that is what was meant, so an edit for a line holding `→`
 * matches whichever way the model spelled the arrow (see `escapes.ts`).
 *
 * Silent, like every interceptor: there is nothing for the model to learn
 * from being told, since the edit went in as it meant it to. It mutates
 * `event.input.edits` directly, as interceptors are sanctioned to (see
 * AGENTS.md "One Mutation Site for Command Rewriting"), and loads before
 * the gates that read an edit's text, so they judge what will be written.
 *
 * Only an edit naming an escape reads the file, so the rest pay nothing.
 * A file that cannot be read is left to the edit tool to report.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	type ExtensionAPI,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { hasEscapes, type Replacement, readEscapes } from "./escapes.ts";

/** Where an edit's path points, as pi's edit tool reads it. */
function editedPath(path: string, cwd: string): string {
	const bare = path.startsWith("@") ? path.slice(1) : path;
	if (bare === "~") return homedir();
	if (bare.startsWith("~/")) return join(homedir(), bare.slice(2));
	return resolve(cwd, bare);
}

/** The edit's replacements, when it has the shape pi's edit tool takes. */
function replacementsOf(input: unknown): Replacement[] | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const { edits } = input as { edits?: unknown };
	if (!Array.isArray(edits)) return undefined;
	const replacements = edits.filter(
		(edit): edit is Replacement =>
			typeof edit === "object" &&
			edit !== null &&
			typeof (edit as Replacement).oldText === "string" &&
			typeof (edit as Replacement).newText === "string",
	);
	return replacements.length === edits.length ? replacements : undefined;
}

export default function editEscapeInterceptor(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("edit", event)) return;
		const edits = replacementsOf(event.input);
		if (!edits?.some((edit) => hasEscapes(edit.oldText))) return;
		let content: string;
		try {
			content = readFileSync(editedPath(event.input.path, ctx.cwd), "utf8");
		} catch {
			return;
		}
		readEscapes(content, edits);
	});
}
