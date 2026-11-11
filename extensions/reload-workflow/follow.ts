/**
 * A session that follows its install: when a package it runs from an
 * install moves, it reloads itself at the first moment that loses
 * nothing, and says what came in (see lib/internal/reload/follow.ts
 * for why, and for the moments).
 *
 * Only a session somebody sits at follows. A subagent or a print-mode
 * run is short and doing one thing, and reloading it would only cut
 * that short. Every conversation of a host that can reload one follows,
 * whether a screen is attached or not, since each is a session in its
 * own right; each has its own follower, and reloads through its host
 * (hosted.ts), which reloads that conversation alone. Without this a
 * hosted conversation kept the code it started with until something
 * asked it to reload, where plain pi moved on by itself.
 *
 * A plain pi whose extension links moved since it started is started
 * again through its holder rather than reloaded, since a reload would
 * resolve those extensions through their first targets
 * (lib/internal/reload/extension-links.ts). One its holder can't start
 * again keeps the code it runs, and says why.
 */

import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	hosted,
	sessionCell,
	sessionKeyOf,
	withSession,
} from "../../lib/core/session/index.ts";
import { linksMovedSince } from "../../lib/internal/reload/extension-links.ts";
import {
	cameIn,
	dependenciesReady,
	FOLLOW_ENV,
	type Moved,
	missedMove,
	SPREAD_MS,
	spreadOf,
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
import {
	RESTART_ASK,
	type RestartAsk,
} from "../../lib/internal/session/park.ts";
import {
	hostedReloadAsker,
	hostReloads,
	reloadThroughHost,
	retellHostedReload,
} from "./hosted.ts";
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

/**
 * The entry a session writes as its holder is about to start it again,
 * naming the extension links that moved and what came in.
 */
export const RESTARTING_ENTRY = "reload-restarting";

/**
 * The session's one follower, so a reload replaces it rather than adding
 * one. On plain pi it is the process's, under the key it always had; in
 * a host each conversation has its own, so B's start can't stop A's.
 */
const FOLLOWER_CELL = "agentic-harness.reload.follower";

/**
 * Stop this session's follower. A hosted conversation's close calls it,
 * since the close frees its slots and with them the way to stop it.
 */
export function stopFollowing(ctx: ExtensionContext): void {
	const cell = sessionCell<Unwatch>(FOLLOWER_CELL, ctx);
	cell.get()?.();
	cell.clear();
}

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
	let entries: ReturnType<PackageSettings["read"]>;
	try {
		entries = settings.read();
	} catch {
		// Settings pi couldn't read: nothing is known yet, and the follower
		// reads them again while it knows no install.
		return [];
	}
	for (const entry of entries) {
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
 * A conversation of a host that can't reload one never follows, since
 * its reload would be the whole process's.
 */
export async function follow(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	settings: PackageSettings,
	running: () => Loaded,
	{
		env = process.env,
		quietMs,
		spreadMs = SPREAD_MS,
		extensions = join(getAgentDir(), "extensions"),
		startedAt = performance.timeOrigin,
	}: {
		env?: NodeJS.ProcessEnv;
		quietMs?: number;
		spreadMs?: number;
		/** The folder of extension links whose moves need a new process. */
		extensions?: string;
		/** When this process started, epoch ms. */
		startedAt?: number;
	} = {},
): Promise<Follower | undefined> {
	const inHost = hosted() !== undefined;
	if (inHost && !hostReloads()) return undefined;
	stopFollowing(ctx);
	if (
		(!inHost && !ctx.hasUI) ||
		isSubagent(env) ||
		env[FOLLOW_ENV]?.trim() === "off"
	) {
		return undefined;
	}

	// The first HEAD seen of each root that moved, so a second move
	// before the reload says everything since the code that runs. Kept
	// after dispatch, since a reload waits for the session to be still
	// and more can land meanwhile; the next runtime starts with none.
	const moved = new Map<string, Moved>();
	let recheck: NodeJS.Timeout | undefined;
	// Stops the watch, the look and the recheck, once they are in place.
	let stopper: Unwatch | undefined;
	const stop = () => {
		stopper?.();
		stopper = undefined;
	};
	// When this runtime first heard of a move it hasn't reloaded for, the
	// start of an idle session's place in the spread.
	let heardAt: number | undefined;
	const hear = () => {
		heardAt ??= Date.now();
	};
	/** This session's place in the spread, fixed by its id. */
	const place = (() => {
		let id: string = String(process.pid);
		try {
			id = ctx.sessionManager?.getSessionId?.() ?? id;
		} catch {
			// A context with no session yet is placed by its process.
		}
		return spreadOf(id, spreadMs);
	})();

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
		// A hosted one waits in the conversation's own slot (hosted.ts), and
		// is read back inside its session, since git is asked outside it.
		if (inHost) {
			const reason = await reasonNow();
			within(() => retellHostedReload(ctx, reason));
			return;
		}
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
	// One at a time: considers that overlap while git is asked would each
	// ask it again, and one landing late would make a request nobody sent.
	let dispatching = false;
	// A hosted conversation's reload that its host failed is tried again
	// only after this, epoch ms, so a failure isn't said every look.
	let retryAt = 0;
	const dispatch = async () => {
		if (dispatching) return;
		dispatching = true;
		try {
			const reason = await reasonNow().catch(() => "the install moved");
			// The host waits for the run to end and reloads this conversation
			// alone; its new runtime says it landed, as plain pi's does.
			if (inHost) {
				if (hostedReloadAsker(ctx) !== undefined) return;
				if (!(await reloadThroughHost(ctx, { reason, by: "self" }))) {
					retryAt = Date.now() + HELD_MS;
				}
				return;
			}
			const links = linksMovedSince(extensions, startedAt);
			if (links.length > 0) {
				restartOver(links, reason);
				return;
			}
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
		} finally {
			dispatching = false;
		}
	};

	/**
	 * Have the holder start this session again on its own log, since a
	 * reload would load the moved links' extensions half from their first
	 * targets. The park watch answers only when nothing holds the session
	 * and nobody may be looking at it, and it carries the fence and the
	 * spawner (#1345). Refused, the session keeps the code it runs, asks
	 * again after {@link HELD_MS}, and says why once for each reason.
	 */
	const restartOver = (links: string[], reason: string) => {
		let ask: RestartAsk;
		try {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (sessionFile === undefined) {
				retryAt = Date.now() + HELD_MS;
				sayWhy("its extension links moved, and it has no log to start on", {
					links,
				});
				return;
			}
			ask = { session: ctx.sessionManager.getSessionId(), sessionFile };
		} catch {
			// A stale context belongs to a runtime that has gone.
			sayWhy("its context has gone");
			return;
		}
		pi.events.emit(RESTART_ASK, ask);
		if (ask.restarting === true) {
			try {
				pi.appendEntry(RESTARTING_ENTRY, {
					links,
					reason,
					at: new Date().toISOString(),
				});
			} catch {
				// A stale runtime has no log to write to; the restart goes on.
			}
			return;
		}
		retryAt = Date.now() + HELD_MS;
		const why = `its extension links moved (${links.join(", ")}), and it can't start again: ${ask.why ?? "nothing here starts it again"}`;
		if (waitingNoted.has(why)) return;
		sayWhy(why, { links });
		try {
			ctx.ui.notify(
				`Not reloaded: ${why}. It keeps the code it runs; start it again to take the new install.`,
				"warning",
			);
		} catch {
			// A context with no screen; the entry still says it.
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

	const considerNow = (settled = false) => {
		if (roots.length === 0) roots = installedRoots(settings);
		for (const root of roots) {
			if (moved.has(root)) continue;
			const missed = missedMove(running().root, root);
			if (missed) {
				moved.set(root, missed);
				hear();
			}
		}
		if (moved.size === 0) return;
		const slot = reloadSlot();
		// A rollover is switching logs: the fresh session's follower takes
		// the move up, or this one does once the switch was called off.
		if (slot.rolling) {
			if (recheck) clearTimeout(recheck);
			recheck = setTimeout(() => consider(), RECHECK_MS);
			recheck.unref?.();
			return;
		}
		// Somebody else's reload is waiting or under way, and it loads
		// the install anyway unless it was asked for a tree.
		if (slot.request !== undefined && !letGoIfHeld()) {
			if (slot.request?.by !== "self") {
				sayWhy("another reload is waiting", { by: slot.request?.by });
			}
			return;
		}
		// A hosted conversation's reload waits in its own slot (hosted.ts).
		const asker = inHost ? hostedReloadAsker(ctx) : undefined;
		if (asker !== undefined) {
			if (asker !== "self") sayWhy("another reload is waiting", { by: asker });
			return;
		}
		if (Date.now() < retryAt) {
			if (recheck) clearTimeout(recheck);
			recheck = setTimeout(() => consider(), retryAt - Date.now());
			recheck.unref?.();
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
			// A host goes on running after a conversation's runtime has gone,
			// so its follower stops rather than look every 30 seconds for good.
			if (inHost) stop();
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
			heardAt = undefined;
			return;
		}
		if (moment === "wait") {
			recheck = setTimeout(() => consider(), RECHECK_MS);
			recheck.unref?.();
			return;
		}
		// An idle session waits its place in the spread; one whose run has
		// just ended goes now, since runs end at their own times.
		const left = (heardAt ?? Date.now()) + place - Date.now();
		if (moment === "now" && !settled && left > 0) {
			recheck = setTimeout(() => consider(), left);
			recheck.unref?.();
			return;
		}
		// After a run, the settle calls consider again, idle by then.
		if (moment === "now") void dispatch();
	};
	// A host's slots are found by the conversation each call runs in, and
	// a watch or a timer may call back outside it, where a slot read
	// would throw and take every conversation down with the host.
	const key = inHost ? sessionKeyOf(ctx) : undefined;
	const within = (fn: () => void) =>
		key === undefined ? fn() : withSession(key, fn);
	const consider = (settled = false) => within(() => considerNow(settled));

	const unwatch = await watchHeads(
		roots,
		(one) =>
			within(() => {
				const earlier = moved.get(one.root);
				moved.set(one.root, earlier ? { ...one, from: earlier.from } : one);
				hear();
				const ours = inHost
					? hostedReloadAsker(ctx) === "self"
					: reloadSlot().request?.by === "self";
				if (ours) void retell();
				else consider();
			}),
		quietMs,
	);
	// Read the link itself every so often, whether or not the watch hears.
	const look = setInterval(() => consider(), RECHECK_MS);
	look.unref?.();
	stopper = () => {
		unwatch();
		clearInterval(look);
		if (recheck) clearTimeout(recheck);
	};
	sessionCell<Unwatch>(FOLLOWER_CELL, ctx).set(stopper);
	return { consider };
}
