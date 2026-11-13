/**
 * What a soak's records say: each turn's latency, read from a
 * conversation's log as the time from the prompt's entry to its final
 * answer's, which pi writes as each message ends in the engine, so it
 * is the engine's own turn on either side; what each turn, and each
 * round and tool within it, cost hosted against plain pi's same seeded
 * one; what a screen adds, from a key
 * typed to the prompt's entry and to its first drawing, and from the
 * answer's entry to its drawing at a viewer; the 50th and 99th
 * percentiles of those, and whether they meet the bar; whether
 * a series of weighings settles or keeps growing; and how a hosted
 * conversation's
 * log differs from plain pi's of the same turns, with each side's own
 * folders, times and ids made labels first, as the parity suite does.
 */
import { stripVTControlCharacters } from "node:util";
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

/** When one turn's prompt and its answer were written, in ms since the epoch. */
export interface TurnTime {
	readonly tag: string;
	readonly promptAt: number;
	readonly answerAt: number;
}

/** When a viewer typed a turn's prompt, and what it drew after, if it did. */
export interface Typed {
	readonly keyAt: number;
	/** When the viewer was first sent a frame showing the prompt. */
	readonly shownAt?: number;
	/** When it drew the answer. */
	readonly drawnAt?: number;
	/**
	 * How its conversation woke, when this is the first key since: a key
	 * then can wait on the wake, so it is told apart from the rest.
	 */
	readonly woke?: string;
}

/**
 * What a screen adds to a turn: from the key to the prompt's entry and
 * to the first frame showing it, for keys outside a wake, and the same
 * for the first key after each wake; and from the answer's entry to its
 * drawing (below 0 when the answer is drawn as it streams, before it
 * ends).
 */
export interface ScreenSplit {
	readonly keyToAccepted: Spread;
	readonly keyToDrawn: Spread;
	readonly writtenToDrawn: Spread;
	readonly afterWake: {
		readonly keyToAccepted: Spread;
		readonly keyToDrawn: Spread;
	};
	/**
	 * Keys outside a wake typed within a second of a key into another
	 * conversation, judged apart as a burst and left out of the steady two.
	 */
	readonly burst: {
		readonly keyToAccepted: Spread;
		readonly keyToDrawn: Spread;
		readonly unshown: number;
	};
	/** Turns typed whose answer no viewer was seen to draw. */
	readonly undrawn: number;
	/**
	 * Keys outside a wake whose prompt no viewer was seen to draw, so
	 * keyToDrawn leaves them out; the bar fails past a few of them.
	 */
	readonly unshown: number;
}

/**
 * One hosted turn, with what is known of it: its engine time, plain pi's
 * for the same seeded turn, and its key's times when a viewer typed it.
 */
export interface TurnRecord {
	readonly tag: string;
	/** When its prompt and answer were written, in ms since the epoch. */
	readonly promptAt: number;
	readonly answerAt: number;
	readonly hostedMs: number;
	readonly plainMs?: number;
	/** When its key was typed, in ms since the epoch. */
	readonly keyAt?: number;
	readonly keyToAcceptedMs?: number;
	readonly keyToDrawnMs?: number;
	readonly woke?: string;
	/** Typed within a second of a key into another conversation. */
	readonly burst?: true;
	/** What each of its steps cost over plain pi's, in order, when they pair. */
	readonly stepCostsMs?: readonly number[];
}

/**
 * One step of a turn: a round, from its prompt or a tool's result to
 * the next answer, or a tool, from an answer to a result of its call,
 * each from one entry's time to the next's, in ms since the epoch.
 */
export interface Step {
	readonly kind: "round" | "tool";
	readonly from: number;
	readonly to: number;
}

/** A soak turn's steps, in order. */
export interface TurnSteps {
	readonly tag: string;
	readonly steps: readonly Step[];
}

/** A hosted step with plain pi's same step beside it, and what it cost. */
export interface PairedStep extends Step {
	readonly tag: string;
	/** Its place in its turn's steps. */
	readonly at: number;
	readonly hostedMs: number;
	readonly plainMs: number;
	readonly costMs: number;
}

/** The hosted steps paired with plain pi's, and how many turns paired. */
export interface StepPairing {
	readonly steps: readonly PairedStep[];
	readonly turns: number;
	/**
	 * Hosted turns whose steps didn't pair: plain pi never answered it, or
	 * the two sides' steps differ in number or kind.
	 */
	readonly unpaired: number;
}

/** A spread and its largest value. */
export interface Extent extends Spread {
	readonly max: number;
}

/** What the rounds and the tools cost hosted over plain pi, apart. */
export interface StepCost {
	readonly rounds: Extent;
	readonly tools: Extent;
	readonly turns: number;
	readonly unpaired: number;
}

/** What the turns cost hosted over plain pi, and how many plain pi never answered. */
export interface PairedCost extends Spread {
	readonly unpaired: number;
}

/** Whether each of the bar's figures holds. */
export interface Bar {
	readonly rounds: boolean;
	readonly tools: boolean;
	readonly keyToAccepted: boolean;
	readonly keyToDrawn: boolean;
}

/** A key that took longer than the bar to reach its conversation's log. */
export interface SlowKey {
	readonly tag: string;
	/** When it was typed and when its prompt was written, in ms since the epoch. */
	readonly keyAt: number;
	readonly promptAt: number;
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
	/** How many differ at each place, its entry's index left out. */
	readonly where: Readonly<Record<string, number>>;
	/** How many differ at a place that doesn't differ on every run. */
	readonly unexpected: number;
	/** The first few, for the report, those of substance first. */
	readonly first: readonly Difference[];
}

/**
 * The most a round or a tool may cost hosted over plain pi's same one,
 * at the p99: both play the same seeded answers and tools, so what is
 * left is the host's own, and a stall shows in the step it held up
 * rather than spread across a long turn.
 */
const BAR_STEP_P99_MS = 250;

/** The most any one round or tool may cost over plain pi's. */
const BAR_STEP_MOST_MS = 1000;

/**
 * Keys into different conversations closer than this are a burst:
 * typed together, whoever typed them, they are judged apart.
 */
const BAR_BURST_MS = 1000;

/**
 * The share of hosted turns whose steps may go unpaired before the
 * step figures stop counting: each one left out could hide a stall.
 */
const BAR_UNPAIRED_SHARE = 0.01;

/** The most a key may take, to its log or to its first drawing, at the p99. */
const BAR_KEY_MS = 200;

/**
 * The share of keys outside a wake that may go unseen drawn before
 * keyToDrawn's p99 stops counting: each one left out biases it low.
 */
const BAR_UNSHOWN_SHARE = 0.01;

/** A later half growing slower than this, a checkpoint, has settled. */
const SETTLED_KB_PER_CHECKPOINT = 1024;

/** Growth under this over the whole run is noise, whatever its slope. */
const NOISE_KB = 4096;

/**
 * Places a hosted log and plain pi's differ at on every run, by what
 * each side is: where an entry came from, a job's own id and the
 * journal's trace of the call that wrote it.
 */
const EVERY_RUN = [
	/\.data\.source$/,
	/\.data\.workItemId$/,
	/\.data\.journal\.last\./,
];

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
	return turnTimes(entries).map(({ tag, promptAt, answerAt }) => ({
		tag,
		ms: answerAt - promptAt,
	}));
}

/** What a screen added to each turn a viewer typed, against the log's times. */
export function screenSplit(
	turns: readonly TurnTime[],
	typed: ReadonlyMap<string, Typed>,
): ScreenSplit {
	const steady = keyTimes();
	const waking = keyTimes();
	const bursting = keyTimes();
	const together = burstOf(typed);
	const drawn: number[] = [];
	let undrawn = 0;
	for (const turn of turns) {
		const keys = typed.get(turn.tag);
		if (keys === undefined) continue;
		const into =
			keys.woke !== undefined
				? waking
				: together.has(turn.tag)
					? bursting
					: steady;
		into.accepted.push(turn.promptAt - keys.keyAt);
		if (keys.shownAt !== undefined) into.shown.push(keys.shownAt - keys.keyAt);
		else into.unshown += 1;
		if (keys.drawnAt === undefined) undrawn += 1;
		else drawn.push(keys.drawnAt - turn.answerAt);
	}
	return {
		keyToAccepted: spreadOf(steady.accepted),
		keyToDrawn: spreadOf(steady.shown),
		writtenToDrawn: spreadOf(drawn),
		afterWake: {
			keyToAccepted: spreadOf(waking.accepted),
			keyToDrawn: spreadOf(waking.shown),
		},
		burst: {
			keyToAccepted: spreadOf(bursting.accepted),
			keyToDrawn: spreadOf(bursting.shown),
			unshown: bursting.unshown,
		},
		undrawn,
		unshown: steady.unshown,
	};
}

/**
 * The tags of the keys typed within a second of a key into another
 * conversation, whichever came first: a burst, as when a person's
 * windows all wake at once or a script types into several.
 */
export function burstOf(typed: ReadonlyMap<string, Typed>): Set<string> {
	const keys = [...typed]
		.map(([tag, { keyAt }]) => ({ tag, keyAt, into: conversationOf(tag) }))
		.sort((a, b) => a.keyAt - b.keyAt);
	const found = new Set<string>();
	for (const [at, key] of keys.entries())
		for (const next of keys.slice(at + 1)) {
			if (next.keyAt - key.keyAt > BAR_BURST_MS) break;
			if (next.into === key.into) continue;
			found.add(key.tag);
			found.add(next.tag);
		}
	return found;
}

/** The conversation a turn's tag names: `c3` of `c3-t41`. */
function conversationOf(tag: string): string {
	const turn = tag.lastIndexOf("-t");
	return turn < 0 ? tag : tag.slice(0, turn);
}

/**
 * Whether `writes`, a viewer's output from a key on, show `tag` once
 * joined with their escapes stripped, so a tag a frame split across two
 * writes, or coloured or moved over mid-word, still counts as shown.
 */
export function showsTag(writes: readonly string[], tag: string): boolean {
	return stripVTControlCharacters(writes.join("")).includes(tag);
}

/** Keys' times to their logs and to their first drawings, gathered, and those never seen drawn. */
function keyTimes(): { accepted: number[]; shown: number[]; unshown: number } {
	return { accepted: [], shown: [], unshown: 0 };
}

/**
 * Each hosted turn with plain pi's time for the same seeded turn, by its
 * tag, and its key's times when a viewer typed it, so a reading the
 * report doesn't make can still be made from it.
 */
export function turnRecords(
	hosted: readonly TurnTime[],
	plain: readonly Latency[],
	typed: ReadonlyMap<string, Typed>,
	steps: readonly PairedStep[] = [],
): TurnRecord[] {
	const plainMs = new Map(plain.map(({ tag, ms }) => [tag, ms]));
	const together = burstOf(typed);
	const costs = new Map<string, number[]>();
	for (const { tag, costMs } of steps)
		costs.set(tag, [...(costs.get(tag) ?? []), costMs]);
	return hosted.map(({ tag, promptAt, answerAt }) => {
		const keys = typed.get(tag);
		const paired = plainMs.get(tag);
		const stepCostsMs = costs.get(tag);
		return {
			tag,
			promptAt,
			answerAt,
			hostedMs: answerAt - promptAt,
			...(paired === undefined ? {} : { plainMs: paired }),
			...(keys === undefined
				? {}
				: { keyAt: keys.keyAt, keyToAcceptedMs: promptAt - keys.keyAt }),
			...(keys?.shownAt === undefined
				? {}
				: { keyToDrawnMs: keys.shownAt - keys.keyAt }),
			...(keys?.woke === undefined ? {} : { woke: keys.woke }),
			...(together.has(tag) ? { burst: true } : {}),
			...(stepCostsMs === undefined ? {} : { stepCostsMs }),
		};
	});
}

/**
 * Each soak turn's steps in a log, in order: from its prompt's entry
 * to its answer's, each message entry ending a step, an answer a round
 * and a tool's result a tool.
 */
export function stepsOf(
	entries: readonly Record<string, unknown>[],
): TurnSteps[] {
	return soakTurns(entries).map(({ tag, prompt, answer }) => {
		const steps: Step[] = [];
		let from = timeOf(entries[prompt]);
		for (const later of entries.slice(prompt + 1, answer + 1)) {
			const role = messageOf(later)?.role;
			if (role === undefined) continue;
			const to = timeOf(later);
			if (role === "assistant") steps.push({ kind: "round", from, to });
			else if (role === "toolResult") steps.push({ kind: "tool", from, to });
			from = to;
		}
		return { tag, steps };
	});
}

/**
 * Each hosted step paired with plain pi's at the same place in the
 * same seeded turn. A turn whose two sides took different steps, or
 * that plain pi never answered, pairs none of its steps and is counted.
 */
export function pairSteps(
	hosted: readonly TurnSteps[],
	plain: readonly TurnSteps[],
): StepPairing {
	const plainSteps = new Map(plain.map(({ tag, steps }) => [tag, steps]));
	const paired: PairedStep[] = [];
	let turns = 0;
	for (const { tag, steps } of hosted) {
		const theirs = plainSteps.get(tag);
		const alike =
			theirs !== undefined &&
			theirs.length === steps.length &&
			steps.every((step, at) => theirs[at]?.kind === step.kind);
		if (!alike) continue;
		turns += 1;
		for (const [at, step] of steps.entries()) {
			const plainMs = (theirs[at]?.to ?? 0) - (theirs[at]?.from ?? 0);
			const hostedMs = step.to - step.from;
			paired.push({
				...step,
				tag,
				at,
				hostedMs,
				plainMs,
				costMs: hostedMs - plainMs,
			});
		}
	}
	return { steps: paired, turns, unpaired: hosted.length - turns };
}

/** What the paired rounds and tools cost hosted, each apart. */
export function stepCostOf(pairing: StepPairing): StepCost {
	const costs = (kind: Step["kind"]) =>
		pairing.steps.filter((one) => one.kind === kind).map((one) => one.costMs);
	return {
		rounds: extentOf(costs("round")),
		tools: extentOf(costs("tool")),
		turns: pairing.turns,
		unpaired: pairing.unpaired,
	};
}

/** The paired steps that cost most, at most `most` of them, the costliest first. */
export function slowSteps(pairing: StepPairing, most: number): PairedStep[] {
	return [...pairing.steps].sort((a, b) => b.costMs - a.costMs).slice(0, most);
}

/** A spread of `values` and the largest of them, which is not a number when there are none. */
function extentOf(values: readonly number[]): Extent {
	return {
		...spreadOf(values),
		max: values.length === 0 ? Number.NaN : Math.max(...values),
	};
}

/** An entry's time, in ms since the epoch. */
function timeOf(entry: Readonly<Record<string, unknown>> | undefined): number {
	return Date.parse(String(entry?.timestamp));
}

/**
 * What each turn cost hosted: its time less plain pi's for the same
 * seeded turn, below 0 where plain pi was slower. A turn plain pi never
 * answered is counted apart.
 */
export function pairedCost(
	records: readonly Pick<TurnRecord, "hostedMs" | "plainMs">[],
): PairedCost {
	const costs = records.flatMap(({ hostedMs, plainMs }) =>
		plainMs === undefined ? [] : [hostedMs - plainMs],
	);
	return {
		...spreadOf(costs),
		unpaired: records.length - costs.length,
	};
}

/**
 * Whether the bar holds: each round's and each tool's cost over plain
 * pi's at most 250 ms at the p99 and 1 s at most, and a key outside a
 * wake or a burst at most 200 ms to its log and to its first drawing at
 * the p99. A figure nothing measured fails; so do the steps' when more
 * than 1% of turns went unpaired, and the drawing's when more than 1%
 * of its keys were never seen drawn.
 */
export function barOf(steps: StepCost, screen: ScreenSplit): Bar {
	const unshownAllowed = screen.keyToAccepted.count * BAR_UNSHOWN_SHARE;
	const unpairedAllowed = (steps.turns + steps.unpaired) * BAR_UNPAIRED_SHARE;
	const holds = (extent: Extent) =>
		extent.p99 <= BAR_STEP_P99_MS &&
		extent.max <= BAR_STEP_MOST_MS &&
		steps.unpaired <= unpairedAllowed;
	return {
		rounds: holds(steps.rounds),
		tools: holds(steps.tools),
		keyToAccepted: screen.keyToAccepted.p99 <= BAR_KEY_MS,
		keyToDrawn:
			screen.keyToDrawn.p99 <= BAR_KEY_MS && screen.unshown <= unshownAllowed,
	};
}

/**
 * The keys typed for `turns` whose prompt was written more than `overMs`
 * after it, the slowest first and at most `most` of them, so a p99 says
 * which keys it was.
 */
export function slowKeys(
	turns: readonly TurnTime[],
	typed: ReadonlyMap<string, Typed>,
	overMs: number,
	most: number,
): SlowKey[] {
	return turns
		.flatMap(({ tag, promptAt }) => {
			const keys = typed.get(tag);
			if (keys === undefined) return [];
			const ms = promptAt - keys.keyAt;
			return ms > overMs ? [{ tag, keyAt: keys.keyAt, promptAt, ms }] : [];
		})
		.sort((a, b) => b.ms - a.ms)
		.slice(0, most);
}

/** When each soak turn's prompt and answer were written in a log, in order. */
export function turnTimes(
	entries: readonly Record<string, unknown>[],
): TurnTime[] {
	return soakTurns(entries).map(({ tag, prompt, answer }) => ({
		tag,
		promptAt: timeOf(entries[prompt]),
		answerAt: timeOf(entries[answer]),
	}));
}

/** Where an answered soak turn's prompt and answer sit in a log's entries. */
interface SoakTurn {
	readonly tag: string;
	readonly prompt: number;
	readonly answer: number;
}

/** Each answered soak turn in a log's entries, in order. */
function soakTurns(entries: readonly Record<string, unknown>[]): SoakTurn[] {
	const found: SoakTurn[] = [];
	for (const [prompt, entry] of entries.entries()) {
		const message = messageOf(entry);
		const turn = message?.role === "user" ? asked(message.text) : undefined;
		if (turn === undefined) continue;
		const ack = acknowledged(turn.tag);
		const answer = entries.findIndex((later, at) => {
			if (at <= prompt) return false;
			const said = messageOf(later);
			return said?.role === "assistant" && said.text.includes(ack);
		});
		if (answer < 0) continue;
		found.push({ tag: turn.tag, prompt, answer });
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
	const where: Record<string, number> = {};
	for (const { path } of found) {
		const place = path.replace(/\[\d+(:|\])/g, "[$1");
		where[place] = (where[place] ?? 0) + 1;
	}
	const everyRun = ({ path }: Difference) =>
		EVERY_RUN.some((place) => place.test(path));
	const unexpected = found.filter((one) => !everyRun(one));
	return {
		entries: { hosted: hosted.length, plain: plain.length },
		differences: found.length,
		where,
		unexpected: unexpected.length,
		first: [...unexpected, ...found.filter(everyRun)].slice(
			0,
			FIRST_DIFFERENCES,
		),
	};
}

/**
 * An entry without its id, its parent's id and its time, and a message
 * without the id the soak's provider numbers its answers by, which runs
 * on across both sides.
 */
function withoutPlace(
	entry: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const { id: _id, parentId: _parent, timestamp: _time, ...rest } = entry;
	if (!isRecord(rest.message)) return rest;
	const { responseId: _response, ...message } = rest.message;
	return { ...rest, message };
}
