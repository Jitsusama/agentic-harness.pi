/**
 * How a run said it ended: the `Done:` or `Blocked:` line a run closes
 * with, read from its last text, and the last text itself, read back from
 * a session's leaf.
 *
 * Away mode reads the line to decide whether a run rests or is sent back
 * (extensions/away-workflow), and the mesh reads a `Blocked:` line for the
 * peers it names, since a run resting blocked on a peer is waiting for that
 * peer's next word however it is sent (extensions/mesh-workflow).
 */

import { isRecord } from "../record.ts";
import type { BranchReader, LinkedEntry } from "./branch-walk.ts";

/** Markdown a model dresses a line in: a bullet, a quote, bold. */
const DRESSING = /^(?:[-*>]\s+)*(?:\*\*|__)?/;

/** A run's last non-empty line, trimmed, or empty when it said nothing. */
export function lastLineOf(text: string): string {
	const lines = text.split("\n").map((line) => line.trim());
	return lines.filter((line) => line.length > 0).at(-1) ?? "";
}

/** How the run said it ended, read from its last non-empty line. */
export function endingOf(text: string): "done" | "blocked" | undefined {
	const last = lastLineOf(text);
	if (!last) return undefined;
	const bare = last.replace(DRESSING, "");
	if (/^done:/i.test(bare)) return "done";
	if (/^blocked:/i.test(bare)) return "blocked";
	return undefined;
}

/** The `Blocked:` line a run ended with, without its label. */
export function blockedLine(text: string): string | undefined {
	if (endingOf(text) !== "blocked") return undefined;
	return lastLineOf(text)
		.replace(/^(?:[-*>]\s+)*(?:\*\*|__)?blocked:\s*/i, "")
		.replace(/(?:\*\*|__)$/, "")
		.trim();
}

/**
 * The most entries read back from the leaf for the last thing a run said.
 * What lands after a run ends is a few mesh deliveries and pi's own marks,
 * so a run's text is a handful of entries back; a walk this long has met
 * something other than an ended run.
 */
const MOST_READ_BACK = 200;

/** A session entry as the walk back reads it. */
export interface SaidEntry extends LinkedEntry {
	readonly type: string;
	readonly message?: unknown;
}

/**
 * The text of the session's last assistant message, when that message
 * ended its run with words rather than a tool call; nothing when the last
 * one called a tool, said nothing, or lies too far back to be the run's
 * end. Reading back from the leaf costs only the entries since, never the
 * whole branch.
 */
export function lastRunText(
	session: BranchReader<SaidEntry>,
): string | undefined {
	let id = session.getLeafId();
	for (let read = 0; id && read < MOST_READ_BACK; read += 1) {
		const entry = session.getEntry(id);
		if (!entry) return undefined;
		const said = assistantSaid(entry);
		if (said !== undefined) return said || undefined;
		id = entry.parentId;
	}
	return undefined;
}

/**
 * What an assistant message entry said: its text when it called no tool,
 * an empty string when it called one, nothing when it is no assistant
 * message.
 */
function assistantSaid(entry: SaidEntry): string | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	const content = Array.isArray(message.content) ? message.content : [];
	if (content.some((part) => isRecord(part) && part.type === "toolCall")) {
		return "";
	}
	return content
		.flatMap((part) =>
			isRecord(part) && part.type === "text" && typeof part.text === "string"
				? [part.text]
				: [],
		)
		.join("\n");
}
