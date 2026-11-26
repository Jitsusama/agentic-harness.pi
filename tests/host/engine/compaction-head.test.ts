/** pi's compaction told to durable as a head marker, over a log standing in for durable's. */
import { describe, expect, it } from "vitest";
import type {
	EntryQuery,
	EntryRecord,
	SubmissionDraft,
} from "../../../host/engine/durable-types.ts";
import type { DurableBinding } from "../../../host/engine/hosted-agent/binding.ts";
import {
	markCompaction,
	newestCompaction,
} from "../../../host/engine/hosted-agent/compaction-head.ts";
import type { AgentMessage } from "../../../host/engine/pi-types.ts";

const START = Date.UTC(2026, 10, 26);

/** A user's words, or an answer, at `minute` past the start. */
function said(role: "user" | "assistant", minute: number): AgentMessage {
	return { role, content: [], timestamp: START + minute * 60_000 };
}

/** One entry of durable's log per message, with ids from 1, as durable commits them. */
function logOf(messages: readonly AgentMessage[]): EntryRecord[] {
	return messages.map((message, index) => ({
		id: index + 1,
		kind: message.role === "user" ? "pi.user" : "pi.assistant",
		model: [message],
	}));
}

/** Durable's side of a conversation over `log`, noting every entry its scans hand back and every submission. */
function durableOver(log: EntryRecord[]) {
	const read: number[] = [];
	const submitted: SubmissionDraft[] = [];
	const conversation = {
		id: 1,
		async entries(query: EntryQuery, limit: number, cursor: unknown) {
			expect(query.order, "the marking reads newest first").toBe("descending");
			const below = typeof cursor === "number" ? cursor : Number.MAX_VALUE;
			const items = log
				.filter((entry) => entry.id < below)
				.sort((a, b) => b.id - a.id)
				.slice(0, limit);
			read.push(...items.map((entry) => entry.id));
			const last = items.at(-1);
			return {
				items,
				...(items.length === limit && last ? { next: last.id } : {}),
			};
		},
		async submit(draft: SubmissionDraft) {
			submitted.push(draft);
			if (draft.type === "write")
				log.push({ id: log.length + 1, ...draft.entry });
			return { id: submitted.length, wait: async () => ({ status: "done" }) };
		},
	};
	const durable = { conversation, context: {} } as unknown as DurableBinding;
	return { durable, read, submitted };
}

/** A session's context as pi builds it after compacting: its summary, then what it kept. */
function compactedContext(
	kept: readonly AgentMessage[],
	at: number,
): AgentMessage[] {
	return [
		{ role: "system", content: "", timestamp: START },
		{ role: "compactionSummary", summary: "so far", timestamp: at },
		...kept,
	];
}

describe("marking pi's compaction for durable", () => {
	// Two thousand messages over two days, a minute apart; pi keeps the last four.
	const history = Array.from({ length: 2000 }, (_, minute) =>
		said(minute % 2 === 0 ? "user" : "assistant", minute),
	);
	const kept = history.slice(-4);
	const compaction = newestCompaction(
		compactedContext(kept, START + 2001 * 60_000),
	);

	it("starts durable's context at the first entry pi kept, reading only the log's recent end", async () => {
		if (!compaction) throw new Error("no compaction found");
		const { durable, read, submitted } = durableOver(logOf(history));

		await expect(markCompaction(durable, compaction)).resolves.toBe("marked");

		const [marker] = submitted;
		expect(
			marker?.type === "write" ? marker.entry.head : undefined,
			"the marker's head is the entry of the first message pi kept",
		).toBe(1997);
		expect(
			marker?.type === "write" ? marker.entry.kind : undefined,
			"the marker is durable's own compaction entry",
		).toBe("pi.compaction");
		expect(
			read.length,
			"the search stops an hour of entries before what pi kept, not at the log's start",
		).toBeLessThan(history.length / 4);
	});

	it("leaves a compaction durable already holds a marker of", async () => {
		if (!compaction) throw new Error("no compaction found");
		const { durable, submitted } = durableOver(logOf(history));
		await markCompaction(durable, compaction);

		await expect(markCompaction(durable, compaction)).resolves.toBe("already");
		expect(submitted, "only the first marking is submitted").toHaveLength(1);
	});

	it("marks nothing where durable holds none of what pi kept", async () => {
		if (!compaction) throw new Error("no compaction found");
		// Five pages of entries, all a day before what pi kept.
		const { durable, read, submitted } = durableOver(
			logOf(history.slice(0, 1000)),
		);

		await expect(markCompaction(durable, compaction)).resolves.toBe(
			"unmatched",
		);
		expect(submitted, "nothing is submitted").toEqual([]);
		expect(
			read.length,
			"entries far older than what pi kept end the search",
		).toBeLessThanOrEqual(200);
	});

	it("reads past kept words stamped hours before the rest, to the first kept entry", async () => {
		// Words steered in during a three-hour tool round, stamped as typed and committed after it.
		const late = said("user", 1996 - 180.5);
		const log = logOf([...history, late]);
		const steered = newestCompaction(
			compactedContext([...kept, late], START + 2002 * 60_000),
		);
		if (!steered) throw new Error("no compaction found");
		const { durable, submitted } = durableOver(log);

		await markCompaction(durable, steered);

		const [marker] = submitted;
		expect(
			marker?.type === "write" ? marker.entry.head : undefined,
			"the head is the first kept entry, not the late words'",
		).toBe(1997);
	});

	it("reads past an earlier compaction's marker, written after entries pi keeps now", async () => {
		// Marked at a start for a compaction of long before, after what the
		// next compaction keeps, its summary stamped with that older time.
		const long = START + 10 * 60_000;
		const earlier: EntryRecord = {
			id: history.length + 1,
			kind: "pi.compaction",
			model: [
				{
					role: "user",
					content: [{ type: "text", text: "long ago" }],
					timestamp: long,
				},
			],
			data: { reason: "pi", compactedAt: long },
		};
		const after = [said("user", 2010), said("assistant", 2011)];
		const log = [
			...logOf(history),
			earlier,
			...logOf(after).map((entry) => ({
				...entry,
				id: entry.id + history.length + 1,
			})),
		];
		const next = newestCompaction(
			compactedContext([...kept, ...after], START + 2012 * 60_000),
		);
		if (!next) throw new Error("no compaction found");
		const { durable, submitted } = durableOver(log);

		await expect(markCompaction(durable, next)).resolves.toBe("marked");

		const [marker] = submitted;
		expect(
			marker?.type === "write" ? marker.entry.head : undefined,
			"the head is the first entry pi kept, below the earlier marker",
		).toBe(1997);
	});

	it("finds no compaction in a context pi never compacted", () => {
		expect(newestCompaction(history)).toBeUndefined();
	});
});
