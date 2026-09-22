/**
 * Reduce a subagent's event stream to a compact, content-addressed
 * digest.
 *
 * A fleet subagent's `events.ndjson` is a complete record of what it
 * did, per turn, and it is swept once a run is a week old. The sweep is
 * right about disk: keeping the streams whole would cost more than a
 * gigabyte a month. It was wrong about everything else, since the
 * stream was the only record of what fleet spend bought.
 *
 * So the bytes go and the index stays. What survives is every turn's
 * usage exactly as the provider reported it, which tools ran with a
 * digest of their arguments, each result's size and digest, and a
 * digest of the final answer. That is enough to price a fleet, to see
 * it repeat itself, and to ask later whether the parent ever used what
 * came back, without holding any of the content.
 */

import { createHash } from "node:crypto";

/** Width of a stored digest: 96 bits, ample and small. */
const DIGEST_CHARS = 24;

/** A digested tool call: which tool, and a digest of what it was asked. */
export interface DigestedCall {
	readonly id: string;
	readonly name: string;
	readonly argsDigest: string;
}

/** One record of a digested event stream. */
export interface DigestRecord {
	readonly kind: "session" | "user" | "assistant" | "toolResult";
	readonly id?: string;
	readonly cwd?: string;
	readonly timestamp?: string | number;
	readonly model?: string;
	/** The provider's usage object, verbatim, so a figure can be traced. */
	readonly usage?: unknown;
	readonly stopReason?: string;
	readonly toolCalls?: readonly DigestedCall[];
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly isError?: boolean;
	/** Characters of text the record stood for. */
	readonly chars?: number;
	/** Digest of that text, so identical content is recognisable. */
	readonly digest?: string;
}

/** What digesting a stream produced, and what it could not read. */
export interface Digest {
	readonly records: DigestRecord[];
	/**
	 * The final answer, which is what the parent received. Kept apart
	 * because it is the one thing the parent-consumption test needs, and
	 * that test can only be run long after the stream is gone.
	 */
	readonly answer: { readonly chars: number; readonly digest: string } | null;
	readonly coverage: { readonly lines: number; readonly unparseable: number };
}

function digestOf(value: unknown): string {
	const canonical =
		typeof value === "string" ? value : JSON.stringify(value ?? null);
	return createHash("sha256")
		.update(canonical)
		.digest("hex")
		.slice(0, DIGEST_CHARS);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}

/** The text blocks of a message, joined, which is what is digested. */
function textOf(content: unknown): string {
	if (!Array.isArray(content))
		return typeof content === "string" ? content : "";
	return content
		.map((block) => {
			const b = asRecord(block);
			return b?.type === "text" && typeof b.text === "string" ? b.text : "";
		})
		.join("");
}

function callsOf(content: unknown): DigestedCall[] {
	if (!Array.isArray(content)) return [];
	const calls: DigestedCall[] = [];
	for (const block of content) {
		const b = asRecord(block);
		if (b?.type !== "toolCall") continue;
		calls.push({
			id: typeof b.id === "string" ? b.id : "",
			name: typeof b.name === "string" ? b.name : "?",
			argsDigest: digestOf(b.arguments),
		});
	}
	return calls;
}

/**
 * Reduce a subagent's event stream to a compact, content-addressed
 * digest.
 *
 * Only a message's end is kept: its start and its streaming updates
 * restate it, and tool execution events restate the tool result
 * message. Every line is offered and every outcome counted, so a
 * truncated write costs one event rather than the rest of the stream.
 */
export function digestEvents(lines: Iterable<string>): Digest {
	const records: DigestRecord[] = [];
	let answer: Digest["answer"] = null;
	let count = 0;
	let unparseable = 0;

	for (const line of lines) {
		count += 1;
		if (!line.trim()) continue;
		let event: Record<string, unknown> | null;
		try {
			event = asRecord(JSON.parse(line));
		} catch {
			// A line cut short by a crash or an interleaved write. Counted
			// rather than fatal, since aborting at one bad line is how a
			// corpus total once came to a tenth of the truth.
			unparseable += 1;
			continue;
		}
		if (!event) {
			unparseable += 1;
			continue;
		}

		if (event.type === "session") {
			records.push({
				kind: "session",
				id: typeof event.id === "string" ? event.id : undefined,
				cwd: typeof event.cwd === "string" ? event.cwd : undefined,
				timestamp:
					typeof event.timestamp === "string" ? event.timestamp : undefined,
			});
			continue;
		}
		if (event.type !== "message_end") continue;

		const message = asRecord(event.message);
		if (!message) continue;
		const text = textOf(message.content);
		const timestamp =
			typeof message.timestamp === "number" ? message.timestamp : undefined;

		if (message.role === "assistant") {
			const digest = digestOf(text);
			records.push({
				kind: "assistant",
				timestamp,
				model: typeof message.model === "string" ? message.model : undefined,
				usage: message.usage,
				stopReason:
					typeof message.stopReason === "string"
						? message.stopReason
						: undefined,
				toolCalls: callsOf(message.content),
				chars: text.length,
				digest,
			});
			// The last assistant turn is the answer. Overwritten as the
			// stream goes, so a stream that ends mid-thought still names
			// the last thing it said rather than nothing.
			if (text.length > 0) answer = { chars: text.length, digest };
		} else if (message.role === "toolResult") {
			records.push({
				kind: "toolResult",
				timestamp,
				toolCallId:
					typeof message.toolCallId === "string"
						? message.toolCallId
						: undefined,
				toolName:
					typeof message.toolName === "string" ? message.toolName : undefined,
				isError: message.isError === true,
				chars: text.length,
				digest: digestOf(text),
			});
		} else if (message.role === "user") {
			records.push({
				kind: "user",
				timestamp,
				chars: text.length,
				digest: digestOf(text),
			});
		}
	}

	return { records, answer, coverage: { lines: count, unparseable } };
}
