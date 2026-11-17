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
 * Nearer the limit, what a restart would end no longer holds it, since
 * running out ends it all. On 16 November the background host's heap
 * passed half before 09:12, and review rounds and shell jobs held its
 * restart every hour until V8 ran out at 20:44, with every conversation
 * mid-way and every job lost. So past 70% of the limit a restart takes
 * the first moment no conversation has a turn running and every screen
 * is at rest, background work or not, without waiting the ceiling, and
 * looks for that moment every second; past 80% it restarts at once,
 * turns and screens in use and all, while a park still has room to
 * finish, since the park that failed did so at about 87%. Both tiers
 * weigh the heap V8 kept after its last full collection (live-heap.ts),
 * not garbage it has yet to sweep, and act only once the heap has grown
 * 15% of the limit since the host's first look: a host whose resumed
 * conversations alone fill it would otherwise restart at every first
 * look, end their work each time, and free nothing.
 *
 * The look and systemd's stop are not one step: something the person
 * starts between them, in the moment systemctl takes, is parked or ended
 * with the host as a logout would, and its conversation resumes after.
 */

import { realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { dependenciesReady } from "../../lib/internal/reload/follow.ts";
import { installOfVersion } from "../../lib/internal/reload/loaded.ts";
import { type HeapUse, heapAfterFullCollections } from "./live-heap.ts";
import type { SessionIdentity } from "./protocol.ts";
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

/** The share of V8's heap limit past which background work no longer holds a restart. */
const HEAP_UNHELD_SHARE = 0.7;

/** The share past which nothing holds it: not a turn running, not a screen in use. */
const HEAP_URGENT_SHARE = 0.8;

/** How much of V8's limit the heap must have grown since the first look before either share counts. */
const HEAP_GROWN_SHARE = 0.15;

const BYTES_PER_MB = 1024 * 1024;

/** A conversation as the host lists it, for whether it is settled. */
export interface Held {
	readonly state: "busy" | "idle" | "parked";
	/** When it last changed state, as an ISO time. */
	readonly since: string;
}

/**
 * The rule a restart came under: every conversation settled; past the
 * ceiling, at a moment none had a turn running, after waiting this long;
 * or its heap, at this share of V8's limit, ending this many running
 * turns and background jobs.
 */
export type RestartRule =
	| { readonly rule: "settled" }
	| { readonly rule: "ceiling"; readonly waitedMs: number }
	| {
			readonly rule: "heap";
			readonly share: number;
			readonly turns: number;
			readonly jobs: number;
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
	/** The share of V8's heap limit the host uses, from 0 to 1; none counted when missing. */
	heapShare?(): number;
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
	// The heap's share at the first look, which the heap tiers weigh growth from.
	let firstShare: number | undefined;
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
		cancel =
			next === "restarting"
				? after(options.restartDueMs ?? RESTART_DUE_MS, () => void dropped())
				: after(
						next === "gap" ? (options.gapLookMs ?? GAP_LOOK_MS) : lookMs,
						() => void look(),
					);
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
		const share = heapShare();
		const background = facts.background();
		const held = facts.held();
		const turns = held.filter(({ state }) => state === "busy").length;
		if (grown(share) && share > HEAP_URGENT_SHARE)
			return { rule: "heap", share, turns, jobs: background };
		const pressed = heapPressed();
		if (background > 0 && !pressed) {
			sayHeld();
			return undefined;
		}
		if (!facts.resting()) return undefined;
		if (background === 0 && settled(held, facts.now(), settledMs))
			return { rule: "settled" };
		if (pressed)
			return turns > 0
				? undefined
				: { rule: "heap", share, turns: 0, jobs: background };
		if (!pastCeiling() || turns > 0) return undefined;
		return { rule: "ceiling", waitedMs: facts.now() - (differingSince ?? 0) };
	}

	function heapShare(): number {
		return facts.heapShare?.() ?? 0;
	}

	// Whether the heap has grown enough since the first look for its tiers to act.
	function grown(share: number): boolean {
		return share - (firstShare ?? share) >= HEAP_GROWN_SHARE;
	}

	// Past 70%, grown since the first look, the heap restarts the host at the first gap.
	function heapPressed(): boolean {
		const share = heapShare();
		return grown(share) && share > HEAP_UNHELD_SHARE;
	}

	async function consider(): Promise<Next> {
		firstShare ??= heapShare();
		// Past the ceiling or pressed by the heap, a look with no gap asks nothing more.
		if ((pastCeiling() || heapPressed()) && mayRestart() === undefined)
			return "gap";
		const why = await facts.differs();
		if (stopped) return "look";
		if (why === undefined) {
			differingSince = undefined;
			heldSaidAt = undefined;
			return "look";
		}
		differingSince ??= facts.now();
		const under = mayRestart();
		if (under === undefined)
			return pastCeiling() || heapPressed() ? "gap" : "look";
		// Before systemctl, since systemd may stop the host before it answers.
		facts.expect(true);
		try {
			await facts.restart(why, under);
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
	report(error: unknown): void;
	/** The version the host runs; its own package root by default. */
	readonly root?: string;
	readonly systemctl?: Systemctl;
	readonly cgroupFile?: string;
	readonly pid?: number;
	/** How much heap the host uses; this process's by default. */
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

	// The heap after V8's last full collection, unless a test gives its own.
	const live = options.heap
		? { read: options.heap, stop: () => undefined }
		: heapAfterFullCollections();
	const heap = live.read;
	function heapPastShare(): string | undefined {
		const { usedBytes, limitBytes } = heap();
		if (usedBytes <= limitBytes * HEAP_RESTART_SHARE) return undefined;
		const mb = (bytes: number) => Math.round(bytes / BYTES_PER_MB);
		return `its heap holds ${mb(usedBytes)} of the ${mb(limitBytes)} MB V8 allows, past half`;
	}

	const settledMs = options.timing?.settledMs ?? SETTLED_MS;
	const stopLooking = restartWhenSettled(
		{
			differs: async () =>
				(await installMoved()) ?? (await unitChanged()) ?? heapPastShare(),
			held: () => options.serving.held(),
			background: options.background,
			...(options.holding ? { holding: options.holding } : {}),
			resting: options.resting,
			heapShare: () => {
				const { usedBytes, limitBytes } = heap();
				return usedBytes / limitBytes;
			},
			stopping: () => options.serving.stopping(),
			expect: (coming) => options.serving.restartComing(coming),
			restart: async (why, under) => {
				options.report(
					`Restarting ${restartedUnder(under, settledMs)}, as ${why}`,
				);
				await systemctl(["--no-block", "restart", unit]);
			},
			report: options.report,
			now: Date.now,
		},
		options.timing,
	);
	return () => {
		stopLooking();
		live.stop();
	};
}

/** `count` of `thing`, plural past one: "1 running turn", "2 background jobs". */
function counted(count: number, thing: string): string {
	return `${count} ${thing}${count === 1 ? "" : "s"}`;
}

const MINUTE_MS = 60_000;

/** The journal's words for the rule a restart came under. */
function restartedUnder(under: RestartRule, settledMs: number): string {
	if (under.rule === "settled") return "once every conversation settled";
	if (under.rule === "heap") {
		const ended = [
			...(under.turns > 0 ? [counted(under.turns, "running turn")] : []),
			...(under.jobs > 0 ? [counted(under.jobs, "background job")] : []),
		];
		return `with its heap at ${Math.round(under.share * 100)}% of what V8 allows, ending ${ended.length > 0 ? ended.join(" and ") : "nothing that was running"}`;
	}
	const waited = Math.round(under.waitedMs / MINUTE_MS);
	const settle = Math.round(settledMs / MINUTE_MS);
	return `at a moment no conversation had a turn or a job, having waited ${waited} min for every one to settle ${settle} min at once`;
}
