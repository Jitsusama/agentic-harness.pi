/**
 * A session that follows its install: when a package it runs from an
 * install moves, it reloads itself at the first moment that loses
 * nothing, and says what came in (see lib/internal/reload/follow.ts
 * for why, and for the moments).
 *
 * Only a session somebody sits at follows. A subagent or a print-mode
 * run is short and doing one thing, and reloading it would only cut
 * that short.
 */

import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	cameIn,
	dependenciesReady,
	FOLLOW_ENV,
	type Moved,
	missedMove,
	type Unwatch,
	watchHeads,
	whenToReload,
} from "../../lib/internal/reload/follow.ts";
import {
	installOfVersion,
	isSwapped,
	type Loaded,
} from "../../lib/internal/reload/loaded.ts";
import {
	type PackageSettings,
	sourceOf,
} from "../../lib/internal/reload/settings.ts";
import { reloadSlot } from "../../lib/internal/reload/slot.ts";
import { canonical } from "./lifecycle.ts";
import { COMMAND, RELOAD_ARG } from "./transitions.ts";

/**
 * How often a reload that is waiting on an install looks again, and how
 * often the follower reads the install's link itself, in case its watch
 * was lost.
 */
const RECHECK_MS = 30_000;

/**
 * How long the session's own reload may wait, handed to the command and
 * with no reload under way, before it is asked again. Nine sessions on
 * 29 October heard the install move and never reloaded, silently.
 */
export const HELD_MS = 10 * 60_000;

/** The entry that says why the session's own reload was held. */
export const HELD_ENTRY = "reload-held";

/**
 * The entry that says, once for each reason, why a session that heard
 * its install move isn't asking to reload: it runs a tree, another
 * reload is waiting, or its context has gone. On 30 October three idle
 * sessions stayed six hours on the code the 08:26 restore loaded and
 * said nothing of why.
 */
export const WAITING_ENTRY = "reload-waiting";

/** The process's one follower, so a reload replaces it rather than adding one. */
const FOLLOWER_KEY = Symbol.for("agentic-harness.reload.follower");

type FollowerGlobal = { [FOLLOWER_KEY]?: Unwatch };

/** The follower a runtime hands the reload-workflow extension. */
export interface Follower {
	/**
	 * Look again at whether a waiting reload can happen; `settled` when
	 * a run has just ended, which pi does not yet count as idle.
	 */
	consider(settled?: boolean): void;
}

/** Whether this process is a subagent rather than a session. */
function isSubagent(env: NodeJS.ProcessEnv): boolean {
	return env.SUBAGENT_SUPERVISOR === "1" || Boolean(env.SUBAGENT_RUN_ID);
}

/**
 * Every installed package root the personal settings name. A root that
 * is a link is kept as the link, since the link is what moves.
 */
function installedRoots(settings: PackageSettings): string[] {
	const roots = new Set<string>();
	for (const entry of settings.read()) {
		try {
			const root = settings.rootOf(sourceOf(entry));
			if (root === undefined) continue;
			roots.add(
				lstatSync(root).isSymbolicLink() ? resolve(root) : canonical(root),
			);
		} catch {
			// An entry pi cannot place is not one to follow.
		}
	}
	return [...roots];
}

/**
 * Follow the installs this session runs. Returns nothing when this
 * session does not follow, which the caller reads as nothing to ask.
 */
export async function follow(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	settings: PackageSettings,
	running: () => Loaded,
	{
		env = process.env,
		quietMs,
	}: { env?: NodeJS.ProcessEnv; quietMs?: number } = {},
): Promise<Follower | undefined> {
	const global = globalThis as FollowerGlobal;
	global[FOLLOWER_KEY]?.();
	global[FOLLOWER_KEY] = undefined;
	if (!ctx.hasUI || isSubagent(env) || env[FOLLOW_ENV]?.trim() === "off") {
		return undefined;
	}

	// The first HEAD seen of each root that moved, so a second move
	// before the reload says everything since the code that runs. Kept
	// after dispatch, since a reload waits for the session to be still
	// and more can land meanwhile; the next runtime starts with none.
	const moved = new Map<string, Moved>();
	let recheck: NodeJS.Timeout | undefined;

	const reasonNow = async () => {
		const named = (
			await Promise.all(
				[...moved.values()].map((one) => cameIn(one.root, one.from, one.to)),
			)
		).flat();
		return named.length > 0 ? named.join("; ") : "the install moved";
	};

	/** A dispatched reload of our own, not yet under way, says what came in since. */
	const retell = async () => {
		const slot = reloadSlot();
		if (slot.request?.by !== "self" || slot.reloading) return;
		const reason = await reasonNow();
		if (slot.request?.by !== "self" || slot.reloading) return;
		slot.request = { ...slot.request, reason };
	};

	// Asking git for the reason can take seconds, and the session can be
	// replaced meanwhile (a rollover, a reload), leaving this pi stale. A
	// stale pi throws, and a throw from this unwatched promise takes pi
	// down, as one from a reload's landing did on 22 October. So the send
	// is guarded, and a request it could not send is taken back for the
	// runtime that replaced this one to make.
	const dispatch = async () => {
		const reason = await reasonNow().catch(() => "the install moved");
		const slot = reloadSlot();
		if (slot.request !== undefined) return;
		slot.request = { reason, by: "self" };
		slot.dispatched = true;
		slot.dispatchedAt = Date.now();
		try {
			pi.sendUserMessage(`/${COMMAND} ${RELOAD_ARG}`, {
				expandPromptTemplates: true,
			});
		} catch {
			slot.request = undefined;
			slot.dispatched = false;
		}
	};

	// Read at start, and again while unread: a read that failed as thirty
	// sessions started at once would leave nothing to follow for good.
	let roots = installedRoots(settings);
	let heldNoted = false;
	const waitingNoted = new Set<string>();
	const sayWhy = (reason: string, data: Record<string, unknown> = {}) => {
		if (waitingNoted.has(reason)) return;
		waitingNoted.add(reason);
		try {
			pi.appendEntry(WAITING_ENTRY, {
				reason,
				...data,
				at: new Date().toISOString(),
			});
		} catch {
			// A stale runtime has no log to write to.
		}
	};
	/**
	 * What runs, with its install read again when the start couldn't read
	 * it, since a runtime with no install reads as running a tree.
	 */
	const runningNow = (): Loaded => {
		const loaded = running();
		if (loaded.install !== undefined) return loaded;
		// A version of an install the settings name is that install, behind
		// or not, so it runs its install.
		const ours = installOfVersion(canonical(loaded.root));
		const named = installedRoots(settings).some(
			(root) =>
				ours !== undefined && installOfVersion(canonical(root)) === ours,
		);
		return named ? { ...loaded, install: loaded.root } : loaded;
	};

	/**
	 * Let go of the session's own reload once it has waited past
	 * {@link HELD_MS} with none under way, so it is asked again, and say
	 * once why it was held. One under way is left alone: two reloads that
	 * overlap leave a runtime that never goes stale.
	 */
	const letGoIfHeld = (): boolean => {
		const slot = reloadSlot();
		const since = slot.dispatchedAt;
		if (slot.request?.by !== "self" || since === undefined) return false;
		const heldMs = Date.now() - since;
		if (heldMs < HELD_MS) return false;
		const stuck = slot.performing === true || slot.reloading === true;
		if (!heldNoted) {
			heldNoted = true;
			try {
				pi.appendEntry(HELD_ENTRY, {
					heldMs,
					dispatched: slot.dispatched === true,
					performing: slot.performing === true,
					reloading: slot.reloading === true,
					at: new Date().toISOString(),
				});
			} catch {
				// A stale runtime has no log to write to.
			}
		}
		if (stuck) return false;
		slot.request = undefined;
		slot.dispatched = false;
		slot.dispatchedAt = undefined;
		return true;
	};

	const consider = (settled = false) => {
		if (roots.length === 0) roots = installedRoots(settings);
		for (const root of roots) {
			if (moved.has(root)) continue;
			const missed = missedMove(running().root, root);
			if (missed) moved.set(root, missed);
		}
		if (moved.size === 0) return;
		const slot = reloadSlot();
		// Somebody else's reload is waiting or under way, and it loads
		// the install anyway unless it was asked for a tree.
		if (slot.request !== undefined && !letGoIfHeld()) {
			if (slot.request?.by !== "self") {
				sayWhy("another reload is waiting", { by: slot.request?.by });
			}
			return;
		}
		if (recheck) clearTimeout(recheck);
		recheck = undefined;
		let idle = false;
		try {
			idle = settled || ctx.isIdle();
		} catch {
			// A stale context belongs to a runtime that has gone.
			sayWhy("its context has gone");
			return;
		}
		const now = runningNow();
		const swapped = isSwapped(now);
		if (swapped) {
			sayWhy("it runs a tree", { root: now.root, install: now.install });
		}
		const moment = whenToReload({
			swapped,
			idle,
			ready: [...moved.values()].every((one) =>
				dependenciesReady(one.root, one.at),
			),
		});
		if (moment === "never") {
			moved.clear();
			return;
		}
		if (moment === "wait") {
			recheck = setTimeout(() => consider(), RECHECK_MS);
			recheck.unref?.();
			return;
		}
		// After a run, the settle calls consider again, idle by then.
		if (moment === "now") void dispatch();
	};

	const unwatch = await watchHeads(
		roots,
		(one) => {
			const earlier = moved.get(one.root);
			moved.set(one.root, earlier ? { ...one, from: earlier.from } : one);
			if (reloadSlot().request?.by === "self") void retell();
			else consider();
		},
		quietMs,
	);
	// Read the link itself every so often, whether or not the watch hears.
	const look = setInterval(() => consider(), RECHECK_MS);
	look.unref?.();
	global[FOLLOWER_KEY] = () => {
		unwatch();
		clearInterval(look);
		if (recheck) clearTimeout(recheck);
	};
	return { consider };
}
