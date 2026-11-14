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
 * conversation and the next host resumes each before it listens, so a
 * viewer told the host is restarting joins the same conversation again.
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
 * The look and systemd's stop are not one step: something the person
 * starts between them, in the moment systemctl takes, is parked or ended
 * with the host as a logout would, and its conversation resumes after.
 */

import { realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { dependenciesReady } from "../../lib/internal/reload/follow.ts";
import { installOfVersion } from "../../lib/internal/reload/loaded.ts";
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
	| { readonly rule: "ceiling"; readonly waitedMs: number };

/** What the restart loop asks of the host and the machine; tests give their own. */
export interface RestartFacts {
	/** Why the host would start differently now, or nothing when it wouldn't. */
	differs(): Promise<string | undefined>;
	/** What the host holds now. */
	held(): readonly Held[];
	/** How much background work the conversations hold, which a restart would end. */
	background(): number;
	/** Whether every screen shows only an empty editor, with nobody in one. */
	resting(): boolean;
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
			new Error(
				"systemd queued the host's restart but never ran it; looking again",
			),
		);
		await look();
	}

	function pastCeiling(): boolean {
		return (
			differingSince !== undefined && facts.now() - differingSince >= ceilingMs
		);
	}

	// The rule a restart may come under now, or nothing while it may not.
	function mayRestart(): RestartRule | undefined {
		if (facts.stopping()) return undefined;
		if (facts.background() > 0 || !facts.resting()) return undefined;
		const held = facts.held();
		if (settled(held, facts.now(), settledMs)) return { rule: "settled" };
		if (!pastCeiling() || held.some(({ state }) => state === "busy"))
			return undefined;
		return { rule: "ceiling", waitedMs: facts.now() - (differingSince ?? 0) };
	}

	async function consider(): Promise<Next> {
		// Past the ceiling, a look with no gap asks nothing more.
		if (pastCeiling() && mayRestart() === undefined) return "gap";
		const why = await facts.differs();
		if (stopped) return "look";
		if (why === undefined) {
			differingSince = undefined;
			return "look";
		}
		differingSince ??= facts.now();
		const under = mayRestart();
		if (under === undefined) return pastCeiling() ? "gap" : "look";
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
	readonly serving: Pick<ServingHost, "held" | "restartComing" | "stopping">;
	/** How much background work the conversations hold (the engine's). */
	background(): number;
	/** Whether every screen is at rest (screens.ts). */
	resting(): boolean;
	report(error: unknown): void;
	/** The version the host runs; its own package root by default. */
	readonly root?: string;
	readonly systemctl?: Systemctl;
	readonly cgroupFile?: string;
	readonly pid?: number;
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

	const settledMs = options.timing?.settledMs ?? SETTLED_MS;
	return restartWhenSettled(
		{
			differs: async () => (await installMoved()) ?? (await unitChanged()),
			held: () => options.serving.held(),
			background: options.background,
			resting: options.resting,
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
}

const MINUTE_MS = 60_000;

/** The journal's words for the rule a restart came under. */
function restartedUnder(under: RestartRule, settledMs: number): string {
	if (under.rule === "settled") return "once every conversation settled";
	const waited = Math.round(under.waitedMs / MINUTE_MS);
	const settle = Math.round(settledMs / MINUTE_MS);
	return `at a moment no conversation had a turn or a job, having waited ${waited} min for every one to settle ${settle} min at once`;
}
