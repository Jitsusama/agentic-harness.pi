/**
 * What a soak's records say: each turn's latency, read from a
 * conversation's log as the time from the prompt's entry to its final
 * answer's; the 50th and 99th percentiles of those; whether a series of
 * weighings settles or keeps growing; and how a hosted conversation's
 * log differs from plain pi's of the same turns, with each side's own
 * folders, times and ids made labels first, as the parity suite does.
 */
import { isRecord } from "../../../lib/internal/record.ts";
import {
	alignedEvents,
	type Difference,
	normalise,
} from "../parity/compare.ts";
import { textOf } from "./soak-provider.ts";
import { acknowledged, asked } from "./turns.ts";

/** One turn's latency. */
export interface Latency {
	readonly tag: string;
	readonly ms: number;
}

/** A series' 50th and 99th percentiles and how many it held. */
export interface Spread {
	readonly count: number;
	readonly p50: number;
	readonly p99: number;
}

/** Whether a series of weighings settles, and by how much it grew. */
export interface Growth {
	readonly verdict: "settles" | "grows" | "too short";
	/** From its first weighing after warming up to its last, in kB. */
	readonly grewKb: number;
	/** How fast its later half grew, in kB a checkpoint. */
	readonly lateKbPerCheckpoint: number;
}

/** How one conversation's two logs differ. */
export interface Parity {
	readonly entries: { readonly hosted: number; readonly plain: number };
	readonly differences: number;
	/** The first few, for the report. */
	readonly first: readonly Difference[];
}

/** A later half growing slower than this, a checkpoint, has settled. */
const SETTLED_KB_PER_CHECKPOINT = 1024;

/** Growth under this over the whole run is noise, whatever its slope. */
const NOISE_KB = 4096;

/** How many differences a parity report names. */
const FIRST_DIFFERENCES = 10;

/** The weighings a series needs past its warm-up to be judged. */
const JUDGED_AT_LEAST = 3;

/** A session log's entries, each line's JSON. */
export function entriesOf(log: string): Record<string, unknown>[] {
	return log
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => {
			const entry: unknown = JSON.parse(line);
			return entry !== null && typeof entry === "object"
				? Object.fromEntries(Object.entries(entry))
				: {};
		});
}

/** Each soak turn's latency in a log's entries, in order. */
export function latencies(
	entries: readonly Record<string, unknown>[],
): Latency[] {
	const found: Latency[] = [];
	for (const [at, entry] of entries.entries()) {
		const message = messageOf(entry);
		const turn = message?.role === "user" ? asked(message.text) : undefined;
		if (turn === undefined) continue;
		const ack = acknowledged(turn.tag);
		const answer = entries.slice(at + 1).find((later) => {
			const said = messageOf(later);
			return said?.role === "assistant" && said.text.includes(ack);
		});
		if (answer === undefined) continue;
		const ms =
			Date.parse(String(answer.timestamp)) -
			Date.parse(String(entry.timestamp));
		found.push({ tag: turn.tag, ms });
	}
	return found;
}

/** A message entry's role and text, or nothing when it isn't one. */
function messageOf(
	entry: Readonly<Record<string, unknown>>,
): { readonly role: string; readonly text: string } | undefined {
	const { message } = entry;
	if (entry.type !== "message" || !isRecord(message)) return undefined;
	const { role } = message;
	if (typeof role !== "string") return undefined;
	return { role, text: textOf(message) };
}

/** The 50th and 99th percentiles of `values`, by nearest rank. */
export function spreadOf(values: readonly number[]): Spread {
	const sorted = [...values].sort((a, b) => a - b);
	const rank = (share: number) =>
		sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)] ?? Number.NaN;
	return { count: sorted.length, p50: rank(0.5), p99: rank(0.99) };
}

/**
 * Whether a series of weighings, in kB at each checkpoint, settles: its
 * first is left out as the warm-up, where pi loads what it loads once,
 * and what's left grows by a leak when its later half still climbs
 * faster than a MB a checkpoint and it grew past 4 MB in all.
 */
export function growthOf(series: readonly number[]): Growth {
	const judged = series.slice(1);
	const first = judged.at(0) ?? 0;
	const grewKb = (judged.at(-1) ?? 0) - first;
	if (judged.length < JUDGED_AT_LEAST)
		return { verdict: "too short", grewKb, lateKbPerCheckpoint: 0 };
	const late = judged.slice(Math.floor(judged.length / 2));
	const lateKbPerCheckpoint = slopeOf(late);
	const grows =
		lateKbPerCheckpoint > SETTLED_KB_PER_CHECKPOINT && grewKb > NOISE_KB;
	return {
		verdict: grows ? "grows" : "settles",
		grewKb,
		lateKbPerCheckpoint: Math.round(lateKbPerCheckpoint),
	};
}

/** The least-squares slope of `values` against their places. */
function slopeOf(values: readonly number[]): number {
	const count = values.length;
	if (count < 2) return 0;
	const meanAt = (count - 1) / 2;
	const mean = values.reduce((sum, value) => sum + value, 0) / count;
	let over = 0;
	let under = 0;
	for (const [at, value] of values.entries()) {
		over += (at - meanAt) * (value - mean);
		under += (at - meanAt) ** 2;
	}
	return over / under;
}

/**
 * How a hosted conversation's log differs from plain pi's, each side's
 * own folder made the label `<root>` first. Entries are aligned by type,
 * as the parity suite aligns events, so one extra entry reads as one;
 * and each entry's own id, its parent's and its time are left out, since
 * a shifted id would make every later one differ.
 */
export function parityOf(
	hosted: readonly Record<string, unknown>[],
	plain: readonly Record<string, unknown>[],
	roots: { readonly hosted: string; readonly plain: string },
): Parity {
	const comparable = (
		log: readonly Record<string, unknown>[],
		root: string,
	) => {
		const labelled = normalise(log.map(withoutPlace), [[root, "<root>"]]);
		return Array.isArray(labelled) ? labelled : [];
	};
	const found = alignedEvents(
		comparable(plain, roots.plain),
		comparable(hosted, roots.hosted),
	);
	return {
		entries: { hosted: hosted.length, plain: plain.length },
		differences: found.length,
		first: found.slice(0, FIRST_DIFFERENCES),
	};
}

/** An entry without its id, its parent's id and its time. */
function withoutPlace(
	entry: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const { id: _id, parentId: _parent, timestamp: _time, ...rest } = entry;
	return rest;
}
