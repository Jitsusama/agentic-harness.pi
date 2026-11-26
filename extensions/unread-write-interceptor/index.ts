/**
 * Unread Write Interceptor Extension
 *
 * Refuses a write that would replace a file its conversation hasn't
 * read whole, or one that changed since the conversation last read or
 * wrote it, saying to read it first or change it with edit. pi's write
 * tool replaces a file whole whether it was read or not, and on 25
 * November a session lost a state file's asks that way.
 *
 * Each conversation keeps the stamp each file had when it last saw all
 * of it (lib/internal/files/unread-write.ts says what a stamp is and
 * which writes lose nothing). The stamps sit in a session slot, so a
 * reload keeps them and a host keeps each conversation's apart. The
 * guard redirects: the same write sent again over the file as it now
 * is goes through, since the agent may know a file its own command
 * made; a file that changes after is a new refusal.
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { sessionCwd, sessionSlot } from "../../lib/core/session/index.ts";
import { refusalUnder } from "../../lib/guardian/apply.ts";
import { toolPath } from "../../lib/internal/files/tool-path.ts";
import {
	stampNow,
	unreadWriteRefusal,
} from "../../lib/internal/files/unread-write.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";

/** The tools whose success can show the conversation a file as it now is. */
const SEEING = new Set(["read", "write", "edit"]);

/** The slot holding a conversation's stamps, by the file's absolute path. */
const STAMPS = "pi:unread-write-stamps";

export default function unreadWriteInterceptor(pi: ExtensionAPI) {
	declareGuards(GUARDS.unreadWrite);
	// The stamp each file had as a read or edit began, by its call, so a
	// change made while it ran is not taken as seen.
	const before = new Map<string, string | undefined>();

	pi.on("tool_call", async (event, ctx) => {
		const file = fileOf(event.input, sessionCwd(ctx));
		if (file === undefined || !SEEING.has(event.toolName)) return undefined;
		if (!isToolCallEventType("write", event)) {
			before.set(event.toolCallId, stampNow(file));
			return undefined;
		}
		const stamps = stampsOf(ctx);
		const refused =
			stamps === undefined
				? unreadWriteRefusal(file, undefined)
				: unreadWriteRefusal(file, stamps.get(file));
		return refusalUnder(
			GUARDS.unreadWrite.name,
			refused === undefined ? undefined : { block: true, reason: refused },
			"A write over an unread file",
			`${file}\0${stampNow(file) ?? ""}`,
		);
	});

	pi.on("tool_result", async (event, ctx) => {
		const began = before.get(event.toolCallId);
		before.delete(event.toolCallId);
		if (event.isError || !SEEING.has(event.toolName)) return undefined;
		const file = fileOf(event.input, sessionCwd(ctx));
		const stamps = stampsOf(ctx);
		if (file === undefined || stamps === undefined) return undefined;
		const now = stampNow(file);
		if (now !== undefined && seesItWhole(event, began, now, stamps.get(file)))
			stamps.set(file, now);
		else stamps.delete(file);
		return undefined;
	});

	pi.on("session_shutdown", async (event, ctx) => {
		// A reload carries on the same conversation; anything else ends it.
		if (event.reason !== "reload") stampsOf(ctx)?.clear();
	});
}

/**
 * Whether a finished call leaves the conversation knowing the whole file
 * as it now is: a write, which put it there; a read of all of it that
 * nothing changed under, its stamp the same at its start and its end;
 * or an edit of a file it already knew, as it was when the edit began.
 */
function seesItWhole(
	event: {
		readonly toolName: string;
		readonly input: unknown;
		readonly details?: unknown;
	},
	began: string | undefined,
	now: string,
	known: string | undefined,
): boolean {
	if (event.toolName === "write") return true;
	if (began === undefined) return false;
	if (event.toolName === "edit") return known === began;
	return began === now && !isPartialRead(event.input, event.details);
}

/** Whether a read showed less than the whole file: a slice, or cut short. */
function isPartialRead(input: unknown, details: unknown): boolean {
	const sliced =
		typeof input === "object" &&
		input !== null &&
		(("offset" in input && input.offset !== undefined) ||
			("limit" in input && input.limit !== undefined));
	const cut =
		typeof details === "object" && details !== null && "truncation" in details;
	return sliced || cut;
}

/**
 * This conversation's stamps, or nothing where it can't say which
 * conversation it is (a context its session already replaced, in a
 * host), in which case nothing is stamped and every write over a file
 * is refused once.
 */
function stampsOf(ctx: ExtensionContext): Map<string, string> | undefined {
	try {
		return sessionSlot(STAMPS, ctx, () => new Map<string, string>());
	} catch {
		// A stale context, or none in a host: no stamps, so no write over a
		// file goes through unrefused, at the cost of a refusal.
		return undefined;
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
