/**
 * pi's newest compaction, told to durable as a head marker. Durable reads
 * a conversation's context from its newest head marker on, before every
 * request it prepares, and pi compacts in its own session file, so with no
 * marker each such read takes the whole log: on 26 November one start's
 * first request read 38,734 entries (111 MB) on its thread where the 96
 * since pi's compaction would have done. The marker durable is given is
 * one of its own compaction entries, as its compaction would write, its
 * head the first entry pi keeps.
 */

import type { EntryRecord } from "../durable-types.ts";
import type { AgentMessage } from "../pi-types.ts";
import type { DurableBinding } from "./binding.ts";
import { inputData, messageKey } from "./messages.ts";

/** Durable's compaction entry kind, a head marker whose `head` is the first entry kept. */
export const COMPACTION_KIND = "pi.compaction";

/** What a marker of pi's compaction says of it in its data. */
const MARKED_BY = "pi";

/** How many entries each page of the search for the kept entries reads. */
const ENTRY_PAGE = 200;

/**
 * How far before the oldest kept message an entry pi didn't keep may be
 * stamped and still come after it in durable's log, as words steered in
 * during a long tool round are stamped as typed but committed after the
 * round's results. The first entry stamped earlier ends the search: what
 * lies below it went before what pi kept.
 */
const OUT_OF_ORDER_MS = 60 * 60 * 1000;

/** pi's newest compaction, as its messages show it: the summary's time and text, and the messages it kept. */
export interface PiCompaction {
	readonly at: number;
	readonly summary: string;
	readonly kept: readonly AgentMessage[];
}

/** What marking found: a marker written or already there, or no kept entry durable holds. */
export type Marking = "marked" | "already" | "unmatched";

/** Whether a pi session's event says a compaction finished, its context then rebuilt from it. */
export function compacted(event: { readonly type: string }): boolean {
	return (
		event.type === "compaction_end" &&
		Reflect.get(event, "aborted") !== true &&
		Reflect.get(event, "result") !== undefined
	);
}

/** pi's newest compaction in `messages`, the session's context as pi builds it, if it has one. */
export function newestCompaction(
	messages: readonly AgentMessage[],
): PiCompaction | undefined {
	let index = messages.length - 1;
	while (index >= 0 && messages[index]?.role !== "compactionSummary") index--;
	const found = messages[index];
	if (!found || typeof found.timestamp !== "number") return undefined;
	return {
		at: found.timestamp,
		summary: typeof found.summary === "string" ? found.summary : "",
		kept: messages.slice(index + 1),
	};
}

/**
 * Give durable a head marker at the first entry of `compaction`'s kept
 * messages, unless one for it is there already. Read newest first, so
 * only the entries since about the compaction are read.
 */
export async function markCompaction(
	durable: DurableBinding,
	compaction: PiCompaction,
): Promise<Marking> {
	const found = await keptHead(durable, compaction);
	if (found === "already" || found === undefined) return found ?? "unmatched";
	const entry = {
		kind: COMPACTION_KIND,
		head: found,
		model: [
			{
				role: "user",
				content: [{ type: "text", text: compaction.summary }],
				timestamp: compaction.at,
			},
		],
		data: { reason: MARKED_BY, compactedAt: compaction.at },
	};
	// The request id makes a second marking of the same compaction durable's no-op.
	await durable.conversation.submit(
		{ type: "write", requestId: requestId(compaction), entry },
		durable.context,
	);
	return "marked";
}

/** The request id a marker of `compaction` is admitted under. */
function requestId(compaction: PiCompaction): string {
	return `${MARKED_BY}-compaction:${compaction.at}`;
}

/**
 * The id of the oldest durable entry holding one of the kept messages, or
 * "already" on meeting a marker of this compaction first. A tool result is
 * not looked for, since pi keeps none without the answer that called it,
 * and neither is a system message, which durable writes as its own.
 */
async function keptHead(
	durable: DurableBinding,
	compaction: PiCompaction,
): Promise<number | "already" | undefined> {
	const wanted = new Set(
		compaction.kept
			.filter(
				(message) => message.role !== "system" && message.role !== "toolResult",
			)
			.map(messageKey),
	);
	const stamps = compaction.kept.flatMap((message) =>
		typeof message.timestamp === "number" ? [message.timestamp] : [],
	);
	if (wanted.size === 0 || stamps.length === 0) return undefined;
	const floor = Math.min(...stamps) - OUT_OF_ORDER_MS;
	const { conversation, context } = durable;
	let head: number | undefined;
	let cursor: unknown;
	do {
		const page = await conversation.entries(
			{ order: "descending" },
			ENTRY_PAGE,
			cursor,
			context,
		);
		for (const entry of page.items) {
			if (marks(entry, compaction)) return "already";
			// An earlier compaction's marker is neither what pi kept nor a sign
			// of order: written at a start, it lies after entries pi keeps now,
			// its summary stamped with that compaction's older time.
			if (entry.kind === COMPACTION_KIND) continue;
			const messages = messagesOf(entry);
			if (messages.some((message) => wanted.has(messageKey(message))))
				head = entry.id;
			else if (
				messages.length > 0 &&
				messages.every((message) => before(message, floor))
			)
				return head;
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return head;
}

/** Whether `entry` is a marker of `compaction`. */
function marks(entry: EntryRecord, compaction: PiCompaction): boolean {
	if (entry.kind !== COMPACTION_KIND) return false;
	const data = entry.data;
	return (
		typeof data === "object" &&
		data !== null &&
		Reflect.get(data, "reason") === MARKED_BY &&
		Reflect.get(data, "compactedAt") === compaction.at
	);
}

/** The pi messages an entry holds: an input's as pi showed them, or its model's. */
function messagesOf(entry: EntryRecord): readonly AgentMessage[] {
	return inputData(entry)?.messages ?? entry.model ?? [];
}

/** Whether `message` is stamped before `floor`. */
function before(message: AgentMessage, floor: number): boolean {
	return typeof message.timestamp === "number" && message.timestamp < floor;
}
