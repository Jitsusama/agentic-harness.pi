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
 * reload keeps them and a host keeps each conversation's apart; a
 * compaction or a move in the session tree forgets them, since the
 * context may no longer hold what was read. A same-size change within
 * the filesystem's mtime resolution passes as unchanged. The guard
 * redirects: the same write sent again over the file as it now
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
	editDelta,
	stampNow,
	stampSize,
	unreadWriteRefusal,
	writtenAsSent,
} from "../../lib/internal/files/unread-write.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";

/** The tools whose success can show the conversation a file as it now is. */
const SEEING = new Set(["read", "write", "edit"]);

/** The slot holding a conversation's stamps, by the file's absolute path. */
const STAMPS = "pi:unread-write-stamps";

/** How many of a file's earlier stamps an edit may have begun from. */
const HELD_STAMPS = 8;

/**
 * What a conversation knows of a file: its stamp when last seen whole,
 * and the stamps it held before that through its own writes and edits,
 * so edits sent together each count from the one before.
 */
interface Seen {
	readonly now: string;
	readonly held: readonly string[];
}

/** A finished call on a file, as its tool_result reports it. */
interface Finished {
	readonly toolName: string;
	readonly input: unknown;
	readonly details?: unknown;
}

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
		const refused = unreadWriteRefusal(file, stampsOf(ctx)?.get(file)?.now);
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
		const seen = stamps.get(file);
		if (now === undefined) stamps.delete(file);
		else if (seesItWhole(event, file, began, now, seen))
			stamps.set(file, seenNow(event.toolName, now, seen));
		// A call that showed less leaves a stamp the file still has.
		else if (seen?.now !== now) stamps.delete(file);
		return undefined;
	});

	// A call another guard blocked has no tool_result, only this.
	pi.on("tool_execution_end", async (event) => {
		before.delete(event.toolCallId);
	});

	// The context may no longer hold what was read before either.
	pi.on("session_compact", async (_event, ctx) => stampsOf(ctx)?.clear());
	pi.on("session_tree", async (_event, ctx) => stampsOf(ctx)?.clear());

	pi.on("session_shutdown", async (event, ctx) => {
		// A reload carries on the same conversation; anything else ends it.
		if (event.reason !== "reload") stampsOf(ctx)?.clear();
	});
}

/**
 * What the conversation knows of a file it now sees whole: a read starts
 * afresh, and a write or an edit keeps what it held before, so a later
 * edit sent beside it still counts.
 */
function seenNow(tool: string, now: string, seen: Seen | undefined): Seen {
	if (tool === "read" || seen === undefined) return { now, held: [now] };
	return { now, held: [...seen.held, now].slice(-HELD_STAMPS) };
}

/**
 * Whether a finished call leaves the conversation knowing the whole file
 * as it now is: a write whose text the file still holds; a read of all
 * of it that nothing changed under, its stamp the same at its start and
 * its end; or an edit that began from a version the conversation knew
 * and moved the file's size by just its own replacements, so nothing
 * appended while it waited its turn is taken as seen.
 */
function seesItWhole(
	event: Finished,
	file: string,
	began: string | undefined,
	now: string,
	seen: Seen | undefined,
): boolean {
	if (event.toolName === "write") {
		const input = event.input;
		const content =
			typeof input === "object" && input !== null && "content" in input
				? input.content
				: undefined;
		return writtenAsSent(file, content);
	}
	if (began === undefined) return false;
	if (event.toolName === "edit") {
		const delta = editDelta(event.input);
		return (
			seen !== undefined &&
			delta !== undefined &&
			seen.held.includes(began) &&
			stampSize(now) === stampSize(seen.now) + delta
		);
	}
	return began === now && isWholeRead(event.input, event.details);
}

/**
 * Whether a read showed the whole file: from its first line, with no
 * limit, and not cut short, which pi's read tool says by putting
 * `truncation` in its details only when it cut the text.
 */
function isWholeRead(input: unknown, details: unknown): boolean {
	if (typeof input !== "object" || input === null) return false;
	const offset = "offset" in input ? input.offset : undefined;
	const limit = "limit" in input ? input.limit : undefined;
	const fromTheTop =
		offset === undefined || (typeof offset === "number" && offset <= 1);
	const cut =
		typeof details === "object" && details !== null && "truncation" in details;
	return fromTheTop && limit === undefined && !cut;
}

/**
 * This conversation's stamps, or nothing where it can't say which
 * conversation it is (a context its session already replaced, in a
 * host), in which case nothing is stamped and every write over a file
 * is refused once.
 */
function stampsOf(ctx: ExtensionContext): Map<string, Seen> | undefined {
	try {
		return sessionSlot(STAMPS, ctx, () => new Map<string, Seen>());
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
