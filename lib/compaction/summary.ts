/**
 * The compaction summary, asked of the conversation itself.
 *
 * pi's summariser serialises the conversation to text, truncating
 * every tool result to 2,000 characters, and sends it under its own
 * system prompt with prompt caching switched off. So a compaction pays
 * full input price for about half of what it summarises, and the model
 * writing the checkpoint never sees the other half. This module holds
 * the parts of the other way: close the conversation exactly as the
 * session last sent it with one more message asking for the summary.
 * The prefix is then a cache read, a twentieth of the input price on
 * Opus 5.5, and the model reads every token it is summarising.
 *
 * The checkpoint format is pi's, word for word where it can be, so a
 * summary written this way reads like any other to what comes after.
 */

/** Options that shape the closing instruction. */
/**
 * The line a summary written from the whole conversation opens with.
 * It describes the state at the end, yet sits before the messages kept
 * after it, so without this a reader could take those messages for
 * what happened next rather than what the summary already covers.
 */
export const SUMMARY_SPAN =
	"[This summary describes the state at the end of the conversation it replaces, so it already covers the most recent messages, which follow it verbatim.]";

export interface SummaryInstructionOptions {
	/** Whether the conversation opens with an earlier compaction's summary. */
	readonly hasPreviousSummary: boolean;
	/** Extra focus from a manual /compact or another extension. */
	readonly customInstructions?: string;
}

/** What the model's reply has to show to become a checkpoint. */
export interface SummaryReply {
	readonly stopReason: string;
	readonly errorMessage?: string;
	readonly content: ReadonlyArray<{
		readonly type: string;
		readonly text?: string;
	}>;
}

/** A summary ready to persist, or why it cannot be. */
export type SummaryOutcome =
	| { ok: true; text: string }
	| { ok: false; reason: string };

/** The files a compaction saw, as pi's preparation records them. */
export interface FileOperations {
	readonly read: ReadonlySet<string>;
	readonly edited: ReadonlySet<string>;
	readonly written: ReadonlySet<string>;
}

const FORMAT = `Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const FOLD_PREVIOUS = `The conversation above begins with a summary of earlier history. Fold it into the new summary:
- PRESERVE all existing information from that summary that still matters
- ADD new progress, decisions, and context from the messages after it
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- If something is no longer relevant, you may remove it`;

/** The instruction that closes the conversation and asks for its summary. */
export function summaryInstruction(options: SummaryInstructionOptions): string {
	const parts = [
		"[This message is from the harness, not the user.] The session is being compacted: the conversation above will be replaced by a summary you write now, and the most recent messages will be kept verbatim after it. Stop work on the task. Do not call any tool and do not continue the conversation. Write a structured context checkpoint summary that you will use to continue the work.",
	];
	if (options.hasPreviousSummary) parts.push(FOLD_PREVIOUS);
	parts.push(FORMAT);
	if (options.customInstructions) {
		parts.push(`Additional focus: ${options.customInstructions}`);
	}
	parts.push("Reply with the summary only.");
	return parts.join("\n\n");
}

/** Read a summary out of the model's reply, refusing one that cannot be persisted. */
export function readSummary(reply: SummaryReply): SummaryOutcome {
	if (reply.stopReason === "error" || reply.stopReason === "aborted") {
		return { ok: false, reason: reply.errorMessage || reply.stopReason };
	}
	if (reply.content.some((block) => block.type === "toolCall")) {
		return { ok: false, reason: "the summariser called a tool" };
	}
	if (reply.stopReason === "length") {
		return { ok: false, reason: "the summary hit the token cap" };
	}
	const text = reply.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("")
		.trim();
	if (!text) return { ok: false, reason: "the summary was empty" };
	return { ok: true, text };
}

/** The summary with the file lists appended, the way pi's compaction formats them. */
export function withFileLists(summary: string, files: FileOperations) {
	const modified = new Set([...files.edited, ...files.written]);
	const readFiles = [...files.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(
			`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`,
		);
	}
	return {
		summary: sections.length
			? `${summary}\n\n${sections.join("\n\n")}`
			: summary,
		readFiles,
		modifiedFiles,
	};
}

/** The spliced request body, or why the two could not be joined. */
export type SpliceOutcome =
	| { ok: true; payload: Record<string, unknown> & { messages: unknown[] } }
	| { ok: false; reason: string };

type MessagesRequest = Record<string, unknown> & { messages: unknown[] };

function isMessagesRequest(value: unknown): value is MessagesRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as { messages?: unknown }).messages)
	);
}

/**
 * The per-request effort marker Anthropic's managed-effort models
 * carry: a system message with no content. pi-ai puts one before each
 * assistant reply and one at the end for the effort now in force.
 */
function isEffortMarker(message: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;
	const m = message as { role?: unknown; content?: unknown };
	return (
		m.role === "system" && Array.isArray(m.content) && m.content.length === 0
	);
}

/**
 * A message with its cache breakpoints taken out. pi-ai marks the last
 * message of every request, but nothing after a compaction starts with
 * this tail, so a cache write there would cost twice the uncached
 * input price for an entry nobody reads.
 */
function withoutBreakpoints(message: unknown): unknown {
	if (typeof message !== "object" || message === null) return message;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return message;
	return {
		...message,
		content: content.map((block) => {
			if (typeof block !== "object" || block === null) return block;
			const { cache_control: _dropped, ...rest } = block as Record<
				string,
				unknown
			>;
			return rest;
		}),
	};
}

function isSystemUpdate(message: unknown): boolean {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { role?: unknown }).role === "system" &&
		!isEffortMarker(message)
	);
}

/**
 * Close the request the session last sent with the messages it has
 * not sent yet.
 *
 * Everything the session sent stays as it was, system prompt, tools,
 * thinking settings and every message, so the provider reads it back
 * from the cache it wrote. The tail, converted on its own, supplies
 * only what comes after, with no cache breakpoint of its own. The
 * closing effort marker is the session's, so the summary is written at
 * the effort the session runs at.
 *
 * A tail carrying a system update is refused: its rendering depends on
 * which tools the request declared, which the tail was built without.
 */
export function extendSentPayload(
	sent: unknown,
	tail: unknown,
	maxTokens: number,
): SpliceOutcome {
	if (!isMessagesRequest(sent)) {
		return { ok: false, reason: "the last request was not a messages request" };
	}
	if (!isMessagesRequest(tail)) {
		return {
			ok: false,
			reason: "the tail did not convert to a messages request",
		};
	}
	if (tail.messages.some(isSystemUpdate)) {
		return { ok: false, reason: "the tail carries a system update" };
	}
	const closing = sent.messages.at(-1);
	const sentBody = isEffortMarker(closing)
		? sent.messages.slice(0, -1)
		: sent.messages;
	const tailBody = (
		isEffortMarker(tail.messages.at(-1))
			? tail.messages.slice(0, -1)
			: tail.messages
	).map(withoutBreakpoints);
	const messages = [...sentBody, ...tailBody];
	if (isEffortMarker(closing)) messages.push(closing);
	return { ok: true, payload: { ...sent, messages, max_tokens: maxTokens } };
}
