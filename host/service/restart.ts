/**
 * A host restarts itself once what it would start differs from what it
 * runs and nothing it holds would notice: no conversation running, none
 * that changed lately, no background work held, and no screen with a
 * panel open, a gate waiting or words typed.
 *
 * Without this a host ran the harness and pi it started with until a
 * login, a crash or a reboot: its unit is keep-old, so a switch leaves it
 * be, and a hosted conversation's follower moves only the code each
 * conversation loads, never the host's own (OSPHT4, 10 November, part 2
 * of the found loss against plain pi). A restart parks every
 * conversation and the next host resumes each, a viewer's first, before
 * it answers that viewer, so a viewer told the host is restarting joins
 * the same conversation again.
 * The restart itself is systemd's, so the next start reads the unit as
 * systemd has it now, and viewers hear of it only once systemd has it
 * queued, as the host stops (serve.ts).
 *
 * Conversations that take turns may never all rest at once for long: on
 * 12 November the background host's three shared one pause in 14.5
 * hours, of 10 s, and it ran code its install had moved past all that
 * time (OSPHT4 07d3baff). So once a restart has waited the ceiling for
 * them to settle, it takes the first moment none has a turn running,
 * with still no background work held and every screen at rest, and its
 * journal line says it restarted under that rule.
 *
 * Background work is what a restart would end: fleets, codemode and
 * review rounds. A bash call is carried to the next host instead, and
 * on 13 November one always running kept both work hosts from
 * restarting for hours (QCXZEB). Work still holding a restart past the
 * ceiling is named in the journal once an hour, so whoever wonders why
 * a host runs old code reads what holds it; nothing is ended for it.
 *
 * A host also restarts once its heap holds more than half of what V8
 * allows, its install unmoved. On 16 November the background host's
 * heap grew about 300 MB an hour to 3.6 GB of its 4,144 MB limit, and
 * when it was stopped the park ran into the limit: the collector held
 * the loop past systemd's 60 s, so the host was killed with every
 * conversation unparked and four turns failed. At half the limit a
 * stop is still quick, and the restart waits for the same quiet moment
 * as any other, so it parks first.
 *
 * A heap that keeps growing doesn't wait for background work for long,
 * though. On 18 November councils held the background host's restart
 * past half its heap for hours, as sixty conversations always had
 * one running, and at 01:15 V8 aborted it out of memory, ending every
 * turn and every council anyway. So past three-fifths the restart takes
 * the first moment no conversation has a turn running, ending the
 * background work and the screens in use it names in its journal line;
 * and past three-quarters it restarts at once, turns and all, which the
 * next host carries on. Both stay short of the 87% at which the 16
 * November stop ran into the limit, since a stop needs heap of its own.
 * A pressed host says once that it waits for such a moment, and, its
 * drain's held wakes still held, wakes no parked conversation onto a
 * heap already short.
 *
 * Waiting alone found no such moment, though. On 20 November the
 * background host was pressed at 15:22 and waited 52 minutes, as wakes
 * kept starting turns, until its heap passed three-quarters and the
 * restart ended 57 turns. So a pressed host whose turns run drains
 * itself, as a drain asked by hand does: each conversation parks as its
 * turn ends, idle time aside, and a wake waits for the next host, so
 * the turns run out and the moment comes. It stays while a call holds
 * the restart, since the heap is no less short, and while the heap is
 * past half, where the host still means to restart for it. While it
 * stands the heap counts as pressed, though its parks take it under
 * three-fifths: otherwise the ordinary rules would let its held wakes
 * through past the ceiling and wait on heavy runs, and the wakes would
 * grow the heap again. Once the heap is under half, the drain lifts,
 * waking what it held, and any other difference, such as a moved
 * install, waits under the ordinary rules rather than ending
 * background work and screens as a short heap would. A drain standing by hand before the heap
 * was pressed is neither taken over nor lifted; one asked by hand
 * while the heap's stands lifts with it, since the host keeps one
 * drain. One lifted by hand is started again at the next look while
 * the heap is still pressed.
 *
 * The heap is read as the last major collection left it, which counts
 * no garbage: V8's used heap between collections can stand well past
 * what is live, and one such reading could end every turn for nothing.
 * Until the host has seen a major collection it reads the heap as it
 * stands, which in a host's first minutes is small.
 *
 * A restart also waits while the person is on a call or a meeting is
 * near, by the probes the unit names (quiet.ts): on 19 November at
 * 16:38 the attended host restarted itself mid-call as its install
 * moved, and every window on it went with it. A probe that can't tell
 * holds it too. Only a heap that has nearly run out restarts anyway,
 * since the host would soon die mid-call regardless. A held restart
 * looks again each minute, never each second, as a probe takes seconds.
 *
 * The look and systemd's stop are not one step: something the person
 * starts between them, in the moment systemctl takes, is parked or ended
 * with the host as a logout would, and its conversation resumes after.
 */

import { realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import {
	constants,
	type PerformanceEntry,
	PerformanceObserver,
} from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { dependenciesReady } from "../../lib/internal/reload/follow.ts";
import { installOfVersion } from "../../lib/internal/reload/loaded.ts";
import type { SessionIdentity } from "./protocol.ts";
import { quietFrom, RESTART_WAITS_ON_VARIABLE } from "./quiet.ts";
import { hostRoot } from "./rollout.ts";
import type { ServingHost } from "./serve.ts";
import {
	hostCodeOf,
	isUnitMain,
	ownUnit,
	type Systemctl,
	unitDefinition,
	userSystemctl,
} from "./what-starts.ts";

/** How often a host looks whether it would start differently. */
export const LOOK_MS = 60_000;

/**
 * How long every conversation must have sat unchanged before the host
 * restarts: long enough that a run's next turn, or the answer to a
 * question just asked, has come, so a restart lands between uses.
 */
export const SETTLED_MS = 2 * 60_000;

/**
 * How long a restart waits for every conversation to settle at once
 * before it takes any moment with no turn running. On 12 November each
 * of the background host's conversations paused about every 20 to 30
 * minutes, mostly for under a minute, so half an hour gives the settled
 * rule longer than one conversation's usual spacing between pauses.
 */
export const SETTLE_CEILING_MS = 30 * 60_000;

/**
 * How often a host past the ceiling looks for a gap. The one shared
 * pause on 12 November lasted 10 s, which a look a minute would most
 * often miss; each look reads only what the host holds in memory, and
 * asks what it would start only once a gap has come.
 */
export const GAP_LOOK_MS = 1000;

/**
 * How long a host runs before it restarts again for a change, so one
 * that came up on a version still settling isn't moved twice at once.
 */
export const FIRST_LOOK_MS = 5 * 60_000;

/**
 * How long a restart systemd queued may take to stop the host before
 * the host takes it as dropped: no longer expected, so a later stop
 * for another reason tells no viewer to join again, and looked for
 * once more. Systemd runs a queued restart at once unless another job
 * on the unit holds it, so two minutes is long past any it will run.
 */
export const RESTART_DUE_MS = 2 * 60_000;

/** How often a restart held past the ceiling by background work names it. */
export const HELD_SAY_MS = 60 * 60_000;

/** The share of V8's heap limit past which a host restarts. */
const HEAP_RESTART_SHARE = 0.5;

/** The share past which a restart waits for no background work or screen. */
const HEAP_PRESSED_SHARE = 0.6;

/** The share past which a restart waits for nothing, turns included. */
const HEAP_URGENT_SHARE = 0.75;

/**
 * How short the host's heap runs: pressed, when a restart waits only for
 * a moment no turn runs, or urgent, when it waits for nothing.
 */
export type HeapPressure = "pressed" | "urgent";

const BYTES_PER_MB = 1024 * 1024;

/** How much heap the host uses, against the most V8 allows it. */
interface HeapUse {
	readonly usedBytes: number;
	readonly limitBytes: number;
}

/** Whether a performance entry is a major collection's. */
function isMajorCollection(entry: PerformanceEntry): boolean {
	// A gc entry's detail says its kind; node's types don't give it on every entry.
	const detail: unknown = Reflect.get(entry, "detail");
	if (typeof detail !== "object" || detail === null) return false;
	return Reflect.get(detail, "kind") === constants.NODE_PERFORMANCE_GC_MAJOR;
}

/**
 * This process's heap as its last major collection left it, or as it
 * stands until one has run, with the function that stops watching.
 */
function liveHeap(): { read: () => HeapUse; stop: () => void } {
	let collected: number | undefined;
	const watching = new PerformanceObserver((list) => {
		if (list.getEntries().some(isMajorCollection))
			collected = getHeapStatistics().used_heap_size;
	});
	watching.observe({ entryTypes: ["gc"] });
	return {
		read: () => {
			const { used_heap_size, heap_size_limit } = getHeapStatistics();
			return {
				usedBytes: collected ?? used_heap_size,
				limitBytes: heap_size_limit,
			};
		},
		stop: () => watching.disconnect(),
	};
}

/** A conversation as the host lists it, for whether it is settled. */
export interface Held {
	readonly state: "busy" | "idle" | "parked";
	/** When it last changed state, as an ISO time. */
	readonly since: string;
}

/**
 * The rule a restart came under: every conversation settled, or past the
 * ceiling, at a moment none had a turn running, after waiting this long.
 */
export type RestartRule =
	| { readonly rule: "settled" }
	| { readonly rule: "ceiling"; readonly waitedMs: number }
	| {
			readonly rule: "heap";
			readonly pressure: HeapPressure;
			/** The background work the restart ends, a line each. */
			readonly ending: readonly string[];
			/** How many turns it ends mid-answer, which only an urgent one does. */
			readonly turns: number;
			/** Whether a screen is in use as it restarts. */
			readonly screens: boolean;
	  };

/** What the restart loop asks of the host and the machine; tests give their own. */
export interface RestartFacts {
	/** Why the host would start differently now, or nothing when it wouldn't. */
	differs(): Promise<string | undefined>;
	/** What the host holds now. */
	held(): readonly Held[];
	/** How much background work the conversations hold, which a restart would end. */
	background(): number;
	/** What `background` counts, a line each, for the journal. */
	holding?(): readonly string[];
	/** Whether every screen shows only an empty editor, with nobody in one. */
	resting(): boolean;
	/** How short the heap runs, or nothing while it has room. */
	pressure?(): HeapPressure | undefined;
	/**
	 * Whether the heap alone would have the host restart, past half its
	 * limit. While the heap's own drain stands and it would not, the drain
	 * lifts at once, so another difference waits under the ordinary rules;
	 * with no say, the drain lifts only once nothing differs.
	 */
	heapRestarts?(): boolean;
	/**
	 * Start or lift the host's drain for a pressed heap: while it lasts
	 * each conversation parks as its turn ends and a wake waits for the
	 * next host. A throw is reported.
	 */
	drain?(on: boolean): void;
	/**
	 * Whether the host drains now, whoever asked, or nothing when it can't
	 * tell; then the loop goes by the drains it asked for itself.
	 */
	draining?(): boolean | undefined;
	/**
	 * Why the person can't take a restart now, such as "a call is on", or
	 * nothing when they can. A throw means it can't tell, which holds it.
	 */
	quiet?(): Promise<string | undefined>;
	/**
	 * Whether the restart is past its ceiling and waits for a gap, so a
	 * drain for it holds wakes no longer: said at each look that waits
	 * for one, and not as the restart is asked or while the host stops.
	 */
	waitsForGap?(waiting: boolean): void;
	/**
	 * Whether the host has begun stopping. Its parked conversations look
	 * settled, but they parked mid-turn: on 13 November a stop for a throw
	 * passed for a quiet moment, and the host asked for a restart on top.
	 */
	stopping(): boolean;
	/** Say whether a restart is coming, so stopping tells every viewer to join again after. */
	expect(coming: boolean): void;
	/** Have systemd restart the host's unit, without waiting for it. */
	restart(why: string, under: RestartRule): Promise<void>;
	report(error: unknown): void;
	/** Epoch milliseconds. */
	now(): number;
}

/** Whether every conversation has sat idle or parked for `settledMs`. */
export function settled(
	held: readonly Held[],
	now: number,
	settledMs = SETTLED_MS,
): boolean {
	return held.every(
		({ state, since }) =>
			state !== "busy" && now - Date.parse(since) >= settledMs,
	);
}

/**
 * Look every `lookMs` whether the host would start differently, and once
 * it would and everything it holds has settled, ask systemd for the
 * restart, once. Once it has differed for `ceilingMs`, look every
 * `gapLookMs` and take the first moment no conversation runs instead. A
 * refused one is reported and looked at again later,
 * with nothing said to any viewer, and so is one systemd queued but
 * never ran within `restartDueMs`. Answers the function that stops
 * looking.
 */
export function restartWhenSettled(
	facts: RestartFacts,
	options: {
		lookMs?: number;
		settledMs?: number;
		ceilingMs?: number;
		gapLookMs?: number;
		firstLookMs?: number;
		restartDueMs?: number;
		/** Starts a timer; setTimeout by default. */
		after?: (ms: number, run: () => void) => () => void;
	} = {},
): () => void {
	const lookMs = options.lookMs ?? LOOK_MS;
	const settledMs = options.settledMs ?? SETTLED_MS;
	const ceilingMs = options.ceilingMs ?? SETTLE_CEILING_MS;
	const after =
		options.after ??
		((ms, run) => {
			const timer = setTimeout(run, ms);
			timer.unref();
			return () => clearTimeout(timer);
		});
	let stopped = false;
	// Since when the host has differed from what it would start, unbroken.
	let differingSince: number | undefined;
	// When background work holding a restart past the ceiling was last named.
	let heldSaidAt: number | undefined;
	// How short the heap ran at the last look, which a gap look follows.
	let short: HeapPressure | undefined;
	// The pressure a wait for a moment with no turn was last said for.
	let saidPressed: HeapPressure | undefined;
	// Whether this loop drained the host for a pressed heap, not yet lifted,
	// and since when.
	let drained = false;
	let drainedAt: number | undefined;
	// Whether the heap's drain stood its ceiling with a turn still running
	// since the heap was last under half, so one turn that never ends can
	// hold parked work for no longer than the ceiling.
	let drainSpent = false;
	// Whether starting the heap's drain threw since the heap last had room,
	// so a host that can't drain says so once rather than every second.
	let drainRefused = false;
	// Whether only the heap's own drain keeps it pressed, and when the host
	// last asked what differs, so such a heap is asked about each minute.
	let pressedByDrain = false;
	let differsAskedAt: number | undefined;
	// Why a restart was last said to be held for the person, and when.
	let saidQuiet: string | undefined;
	let saidQuietAt: number | undefined;
	// Whether it last said it waits for a gap, so a minute's look says it no longer does.
	let waiting = false;
	let cancel = after(options.firstLookMs ?? FIRST_LOOK_MS, () => void look());

	async function look(): Promise<void> {
		if (stopped) return;
		let next: Next = "look";
		try {
			next = await consider();
		} catch (error) {
			facts.report(error);
		}
		if (stopped) return;
		// A heap short of room lets no held wake through, which would grow it.
		// A look a minute away waits for no gap, so it holds no wake either:
		// a call holding a drained restart must not hold parked work too.
		if (next === "gap")
			waitsForGap(pastCeiling() && short === undefined && !facts.stopping());
		else if (next === "look" && waiting) waitsForGap(false);
		cancel =
			next === "restarting"
				? after(options.restartDueMs ?? RESTART_DUE_MS, () => void dropped())
				: after(
						next === "gap" ? (options.gapLookMs ?? GAP_LOOK_MS) : lookMs,
						() => void look(),
					);
	}

	// A throw here is reported, never ending the looks.
	function waitsForGap(now: boolean): void {
		waiting = now;
		try {
			facts.waitsForGap?.(now);
		} catch (error) {
			facts.report(error);
		}
	}

	async function dropped(): Promise<void> {
		if (stopped) return;
		facts.expect(false);
		facts.report(
			"systemd queued the host's restart but never ran it; looking again",
		);
		await look();
	}

	function pastCeiling(): boolean {
		return (
			differingSince !== undefined && facts.now() - differingSince >= ceilingMs
		);
	}

	// Name what holds a restart past the ceiling, at most once every HELD_SAY_MS.
	function sayHeld(): void {
		if (!pastCeiling()) return;
		const now = facts.now();
		if (heldSaidAt !== undefined && now - heldSaidAt < HELD_SAY_MS) return;
		heldSaidAt = now;
		const holding = facts.holding?.() ?? [];
		facts.report(
			`Restart held past the ceiling by background work: ${holding.length > 0 ? holding.join("; ") : "unnamed"}`,
		);
	}

	// The rule a restart may come under now, or nothing while it may not.
	function mayRestart(): RestartRule | undefined {
		if (facts.stopping()) return undefined;
		if (short !== undefined) return pressed(short);
		if (facts.background() > 0) {
			sayHeld();
			return undefined;
		}
		if (!facts.resting()) return undefined;
		const held = facts.held();
		if (settled(held, facts.now(), settledMs)) return { rule: "settled" };
		if (!pastCeiling() || held.some(({ state }) => state === "busy"))
			return undefined;
		return { rule: "ceiling", waitedMs: facts.now() - (differingSince ?? 0) };
	}

	// A heap running short waits for no background work or screen, and,
	// urgent, for no turn either.
	function pressed(pressure: HeapPressure): RestartRule | undefined {
		const turns = facts.held().filter(({ state }) => state === "busy").length;
		if (pressure === "pressed" && turns > 0) {
			sayPressed(pressure, turns);
			startHeapDrain();
			return undefined;
		}
		const ending = facts.background() > 0 ? (facts.holding?.() ?? []) : [];
		return {
			rule: "heap",
			pressure,
			ending,
			turns,
			screens: !facts.resting(),
		};
	}

	// Say once that a pressed heap waits for a moment with no turn, so the journal isn't silent meanwhile.
	function sayPressed(pressure: HeapPressure, turns: number): void {
		if (saidPressed === pressure) return;
		saidPressed = pressure;
		facts.report(
			`Heap short of room: restarting at the first moment no conversation has a turn, whatever background work or screens hold; ${turns} running now`,
		);
	}

	// Whether the host drains now, by whoever asked.
	function hostDrains(): boolean {
		return facts.draining?.() ?? drained;
	}

	// Drain the host while a pressed heap waits on turns, unless a drain
	// already stands; said once it has started. A throw is reported once.
	function startHeapDrain(): void {
		if (facts.drain === undefined || drainRefused || drainSpent || hostDrains())
			return;
		try {
			facts.drain(true);
		} catch (error) {
			facts.report(error);
			// A drain that took before its throw is the heap's, to lift.
			if (facts.draining?.() !== true) {
				drainRefused = true;
				return;
			}
		}
		drained = true;
		drainedAt = facts.now();
		facts.report(
			"Heap short of room: the host drains, so each conversation parks as its turn ends and wakes wait for the next host",
		);
	}

	// Lift the drain this loop started, saying why; one lifted by hand
	// meanwhile is left as it is.
	function liftHeapDrain(why: string): void {
		if (facts.drain === undefined || !drained) return;
		drained = false;
		// A heap pressed again says so again.
		saidPressed = undefined;
		if (facts.draining?.() === false) return;
		try {
			facts.drain(false);
		} catch (error) {
			facts.report(error);
			return;
		}
		facts.report(
			`${why}: the drain the heap started lifts, and parked conversations wake as asked`,
		);
	}

	// Whether a call or a meeting holds the restart, said once for each
	// reason; a heap that has nearly run out waits for neither.
	async function heldForThePerson(under: RestartRule): Promise<boolean> {
		if (facts.quiet === undefined) return false;
		if (under.rule === "heap" && under.pressure === "urgent") return false;
		let why: string | undefined;
		try {
			why = await facts.quiet();
		} catch (error) {
			why = `it can't tell whether a call is on or a meeting is near: ${String(error)}`;
		}
		const now = facts.now();
		if (
			why !== undefined &&
			(why !== saidQuiet ||
				saidQuietAt === undefined ||
				now - saidQuietAt >= HELD_SAY_MS)
		) {
			facts.report(`Restart held while ${why}`);
			saidQuietAt = now;
		}
		saidQuiet = why;
		if (why === undefined) saidQuietAt = undefined;
		return why !== undefined;
	}

	// Read how short the heap runs, once for each decision, so the rule
	// and its journal line agree. The heap's own drain standing keeps it
	// pressed while the heap would still restart the host, so its parks
	// never undo it; once it would not, the drain lifts.
	function readPressure(): void {
		// A drain lifted by hand is no longer the heap's, so a drain asked
		// by hand after it is its asker's, never taken for a short heap.
		if (drained && facts.draining?.() === false) drained = false;
		const read = facts.pressure?.();
		const pastHalf = facts.heapRestarts?.();
		if (pastHalf === false) drainSpent = false;
		if (read === undefined && pastHalf === false)
			liftHeapDrain("The heap is under half its limit again");
		// Under three-fifths with a turn still running a ceiling on, the
		// drain lifts and is not started again until the heap is under half:
		// it waits for a moment with no turn as it did before drains.
		if (
			read === undefined &&
			drained &&
			drainedAt !== undefined &&
			facts.now() - drainedAt >= ceilingMs
		) {
			drainSpent = true;
			liftHeapDrain("A turn kept the heap's drain standing past its ceiling");
		}
		const heapDrains = drained && facts.draining?.() !== false;
		pressedByDrain = read === undefined && heapDrains;
		short = read ?? (heapDrains ? "pressed" : undefined);
		if (short === undefined) {
			saidPressed = undefined;
			drainRefused = false;
		}
	}

	// Whether a heap only the drain keeps pressed is due to be asked
	// about, so a recovered one lifts within a minute, not at a gap.
	function liftDue(): boolean {
		return (
			pressedByDrain &&
			(differsAskedAt === undefined || facts.now() - differsAskedAt >= lookMs)
		);
	}

	// Whether the next look comes in a second, for a gap, rather than a minute.
	function looksForGap(): boolean {
		return pastCeiling() || short !== undefined;
	}

	async function consider(): Promise<Next> {
		readPressure();
		// Past the ceiling, a look with no gap asks nothing more.
		if (!liftDue() && looksForGap() && mayRestart() === undefined) return "gap";
		differsAskedAt = facts.now();
		const why = await facts.differs();
		if (stopped) return "look";
		if (why === undefined) {
			liftHeapDrain("Nothing left to restart for");
			differingSince = undefined;
			heldSaidAt = undefined;
			saidQuiet = undefined;
			saidQuietAt = undefined;
			return "look";
		}
		differingSince ??= facts.now();
		readPressure();
		const under = mayRestart();
		if (under === undefined) return looksForGap() ? "gap" : "look";
		if (await heldForThePerson(under)) return "look";
		if (stopped) return "look";
		// The probes took seconds, in which a turn or a stop may have begun,
		// so the rule is read again before acting on it.
		readPressure();
		const still = mayRestart();
		if (still === undefined) return looksForGap() ? "gap" : "look";
		// Before systemctl, since systemd may stop the host before it answers.
		waitsForGap(false);
		facts.expect(true);
		try {
			await facts.restart(why, still);
		} catch (error) {
			facts.expect(false);
			throw error;
		}
		return "restarting";
	}

	return () => {
		stopped = true;
		cancel();
	};
}

/** What a look leads to: a restart asked for, the next look, or the next look for a gap. */
type Next = "restarting" | "look" | "gap";

/** What a running host gives the restart loop, and where to look. */
export interface Following {
	readonly serving: Pick<ServingHost, "restartComing" | "stopping"> & {
		/** Each conversation the host runs, by its state and when that last changed. */
		held(): readonly Pick<SessionIdentity, "state" | "since">[];
	};
	/** How much background work the conversations hold (the engine's). */
	background(): number;
	/** What that background work is, a line each (the engine's). */
	holding?(): readonly string[];
	/** Whether every screen is at rest (screens.ts). */
	resting(): boolean;
	/** Whether the restart waits for a gap past its ceiling (restartWhenSettled). */
	waitsForGap?(waiting: boolean): void;
	/** Start or lift the host's drain for a pressed heap (restartWhenSettled). */
	drain?(on: boolean): void;
	/** Whether the host drains now, whoever asked, or nothing when it can't tell (restartWhenSettled). */
	draining?(): boolean | undefined;
	/** Why the person can't take a restart now; the unit's probes by default (quiet.ts). */
	readonly quiet?: () => Promise<string | undefined>;
	report(error: unknown): void;
	/** The version the host runs; its own package root by default. */
	readonly root?: string;
	readonly systemctl?: Systemctl;
	readonly cgroupFile?: string;
	readonly pid?: number;
	/** How much heap the host uses; this process's as its last major collection left it by default. */
	readonly heap?: () => HeapUse;
	/** Passed on to restartWhenSettled, for tests. */
	readonly timing?: Parameters<typeof restartWhenSettled>[1];
}

/**
 * Follow what this host would start, when systemd runs it as a unit's
 * main process, and restart once it differs and everything has settled.
 * A host run any other way, by hand or by a test, follows nothing.
 * Answers the function that stops following.
 */
export async function followWhatStarts(
	options: Following,
): Promise<() => void> {
	const systemctl = options.systemctl ?? userSystemctl;
	const unit = await ownUnit(options.cgroupFile);
	if (
		unit === undefined ||
		!(await isUnitMain(unit, options.pid ?? process.pid, systemctl))
	)
		return () => undefined;
	const root = options.root ?? hostRoot();
	const install = installOfVersion(root);
	const link = install === undefined ? undefined : join(install, "current");
	const [code, definition] = await Promise.all([
		hostCodeOf(root),
		unitDefinition(unit, systemctl),
	]);
	// A version's code never changes under its name, so each is read once.
	const codeOf = new Map<string, Promise<string>>();

	async function installMoved(): Promise<string | undefined> {
		if (link === undefined) return undefined;
		const now = await realpath(link).catch(() => undefined);
		if (now === undefined || now === root || !dependenciesReady(now))
			return undefined;
		let next = codeOf.get(now);
		if (!next) {
			next = hostCodeOf(now);
			codeOf.set(now, next);
		}
		if ((await next) === code) return undefined;
		return `the install's ${basename(now).slice(0, 12)} changes the host's own code`;
	}

	async function unitChanged(): Promise<string | undefined> {
		if (definition === undefined || unit === undefined) return undefined;
		const now = await unitDefinition(unit, systemctl);
		if (now === undefined || now === definition) return undefined;
		return `systemd has a new ${unit}, such as one naming a new pi`;
	}

	const watched = options.heap ? undefined : liveHeap();
	const heap = options.heap ?? watched?.read ?? (() => getHeapUse());
	// The reading the last heap rule was decided on, which its journal line gives.
	let decided: HeapUse | undefined;
	// Why the host differs other than its heap, at the last look.
	let otherwise: string | undefined;
	function pressure(): HeapPressure | undefined {
		decided = heap();
		const { usedBytes, limitBytes } = decided;
		if (usedBytes > limitBytes * HEAP_URGENT_SHARE) return "urgent";
		if (usedBytes > limitBytes * HEAP_PRESSED_SHARE) return "pressed";
		return undefined;
	}

	const settledMs = options.timing?.settledMs ?? SETTLED_MS;
	const quiet =
		options.quiet ?? quietFrom(process.env[RESTART_WAITS_ON_VARIABLE]);
	const unfollow = restartWhenSettled(
		{
			differs: async () => {
				otherwise = (await installMoved()) ?? (await unitChanged());
				return otherwise ?? heapPastShare(heap());
			},
			held: () => options.serving.held(),
			background: options.background,
			...(options.holding ? { holding: options.holding } : {}),
			...(options.waitsForGap ? { waitsForGap: options.waitsForGap } : {}),
			...(options.drain ? { drain: options.drain } : {}),
			...(options.draining ? { draining: options.draining } : {}),
			resting: options.resting,
			pressure,
			heapRestarts: () => heapPastShare(heap()) !== undefined,
			...(quiet ? { quiet } : {}),
			stopping: () => options.serving.stopping(),
			expect: (coming) => options.serving.restartComing(coming),
			restart: async (why, under) => {
				// A heap rule says the reading it was decided on, not an earlier one.
				const as =
					under.rule === "heap" && decided !== undefined
						? [heapPastShare(decided), otherwise]
								.filter((said) => said !== undefined)
								.join(", and ")
						: why;
				options.report(
					`Restarting ${restartedUnder(under, settledMs)}, as ${as}`,
				);
				await systemctl(["--no-block", "restart", unit]);
			},
			report: options.report,
			now: Date.now,
		},
		options.timing,
	);
	return () => {
		unfollow();
		watched?.stop();
	};
}

/** This process's heap as it stands, garbage and all. */
function getHeapUse(): HeapUse {
	const { used_heap_size, heap_size_limit } = getHeapStatistics();
	return { usedBytes: used_heap_size, limitBytes: heap_size_limit };
}

/** How far past a share of V8's limit a heap stands, in words, or nothing while under half. */
function heapPastShare({ usedBytes, limitBytes }: HeapUse): string | undefined {
	const past =
		usedBytes > limitBytes * HEAP_URGENT_SHARE
			? "three-quarters"
			: usedBytes > limitBytes * HEAP_PRESSED_SHARE
				? "three-fifths"
				: usedBytes > limitBytes * HEAP_RESTART_SHARE
					? "half"
					: undefined;
	if (past === undefined) return undefined;
	const mb = (bytes: number) => Math.round(bytes / BYTES_PER_MB);
	return `its heap holds ${mb(usedBytes)} of the ${mb(limitBytes)} MB V8 allows, past ${past}`;
}

const MINUTE_MS = 60_000;

/** The journal's words for the rule a restart came under. */
function restartedUnder(under: RestartRule, settledMs: number): string {
	if (under.rule === "settled") return "once every conversation settled";
	if (under.rule === "heap") {
		const when =
			under.pressure === "urgent"
				? "at once, turns and all"
				: "at a moment no conversation had a turn";
		const ends = [
			...(under.turns > 0 && under.pressure === "urgent"
				? [`${under.turns} turn${under.turns === 1 ? "" : "s"} mid-answer`]
				: []),
			...(under.screens ? ["a screen in use"] : []),
			...under.ending,
		];
		const ending = ends.length > 0 ? `, ending ${ends.join("; ")}` : "";
		return `${when}, before its heap runs out${ending}`;
	}
	const waited = Math.round(under.waitedMs / MINUTE_MS);
	const settle = Math.round(settledMs / MINUTE_MS);
	return `at a moment no conversation had a turn or a job, having waited ${waited} min for every one to settle ${settle} min at once`;
}
