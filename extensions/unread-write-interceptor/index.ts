/**
 * Unread Write Interceptor Extension
 *
 * Refuses a write that would replace a file its conversation hasn't
 * read, or one that changed since the conversation last read or wrote
 * it, saying to read it first or change it with edit. pi's write tool
 * replaces a file whole whether it was read or not, and on 25 November
 * a session lost a state file's asks that way.
 *
 * Each conversation keeps the stamp each file had when it last read,
 * wrote or edited it (lib/internal/files/unread-write.ts says what a
 * stamp is and which writes lose nothing). A host serves several
 * conversations from one load, so the stamps are kept by conversation.
 * The guard redirects: the same write sent again goes through, since a
 * file a command of the conversation made is one it already knows.
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { sessionCwd } from "../../lib/core/session/index.ts";
import { refusalUnder } from "../../lib/guardian/apply.ts";
import { toolPath } from "../../lib/internal/files/tool-path.ts";
import {
	stampNow,
	unreadWriteRefusal,
} from "../../lib/internal/files/unread-write.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";

/** The tools whose success shows the conversation a file as it now is. */
const SEEING = new Set(["read", "write", "edit"]);

export default function unreadWriteInterceptor(pi: ExtensionAPI) {
	declareGuards(GUARDS.unreadWrite);
	// Each conversation's stamps, by the file's absolute path.
	const seen = new Map<string, Map<string, string>>();
	const stampsOf = (ctx: ExtensionContext) => {
		const key = conversationOf(ctx);
		const stamps = seen.get(key) ?? new Map<string, string>();
		seen.set(key, stamps);
		return stamps;
	};

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("write", event)) return undefined;
		const file = fileOf(event.input, sessionCwd(ctx));
		if (file === undefined) return undefined;
		const refused = unreadWriteRefusal(file, stampsOf(ctx).get(file));
		return refusalUnder(
			GUARDS.unreadWrite.name,
			refused === undefined ? undefined : { block: true, reason: refused },
			"A write over an unread file",
			file,
		);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError || !SEEING.has(event.toolName)) return undefined;
		const file = fileOf(event.input, sessionCwd(ctx));
		if (file === undefined) return undefined;
		const stamp = stampNow(file);
		const stamps = stampsOf(ctx);
		if (stamp === undefined) stamps.delete(file);
		else stamps.set(file, stamp);
		return undefined;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		seen.delete(conversationOf(ctx));
	});
}

/** Which conversation `ctx` is, or one key for all where it can't say. */
function conversationOf(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		// A context its session already replaced: its stamps go under one
		// key, which costs a refusal at worst, never a lost file.
		return "";
	}
}

/** The absolute file a file tool's input names, or nothing. */
function fileOf(input: unknown, cwd: string): string | undefined {
	if (typeof input !== "object" || input === null || !("path" in input))
		return undefined;
	const { path } = input;
	if (typeof path !== "string") return undefined;
	try {
		return toolPath(path, cwd);
	} catch {
		// An address no tool can read is no file a write would replace.
		return undefined;
	}
}
