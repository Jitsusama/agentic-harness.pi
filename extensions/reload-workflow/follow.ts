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

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	cameIn,
	dependenciesReady,
	FOLLOW_ENV,
	type Moved,
	type Unwatch,
	watchHeads,
	whenToReload,
} from "../../lib/internal/reload/follow.ts";
import { isSwapped, type Loaded } from "../../lib/internal/reload/loaded.ts";
import {
	type PackageSettings,
	sourceOf,
} from "../../lib/internal/reload/settings.ts";
import { reloadSlot } from "../../lib/internal/reload/slot.ts";
import { findJobHost } from "../../lib/jobs/index.ts";
import { canonical } from "./lifecycle.ts";
import { COMMAND, RELOAD_ARG } from "./transitions.ts";

/** How often a reload that is waiting on jobs or an install looks again. */
const RECHECK_MS = 30_000;

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

/** Every installed package root the personal settings name. */
function installedRoots(settings: PackageSettings): string[] {
	const roots = new Set<string>();
	for (const entry of settings.read()) {
		try {
			const root = settings.rootOf(sourceOf(entry));
			if (root !== undefined) roots.add(canonical(root));
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

	const dispatch = async () => {
		const slot = reloadSlot();
		slot.request = { reason: await reasonNow(), by: "self" };
		slot.dispatched = true;
		pi.sendUserMessage(`/${COMMAND} ${RELOAD_ARG}`, {
			expandPromptTemplates: true,
		});
	};

	const consider = (settled = false) => {
		if (moved.size === 0) return;
		const slot = reloadSlot();
		// Somebody else's reload is waiting or under way, and it loads
		// the install anyway unless it was asked for a tree.
		if (slot.request !== undefined) return;
		if (recheck) clearTimeout(recheck);
		recheck = undefined;
		let idle = false;
		try {
			idle = settled || ctx.isIdle();
		} catch {
			// A stale context belongs to a runtime that has gone.
			return;
		}
		const moment = whenToReload({
			swapped: isSwapped(running()),
			idle,
			pendingJobs: findJobHost(pi.events)?.pending?.() ?? 0,
			ready: [...moved.keys()].every(dependenciesReady),
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
		installedRoots(settings),
		(one) => {
			const earlier = moved.get(one.root);
			moved.set(one.root, earlier ? { ...one, from: earlier.from } : one);
			if (reloadSlot().request?.by === "self") void retell();
			else consider();
		},
		quietMs,
	);
	global[FOLLOWER_KEY] = () => {
		unwatch();
		if (recheck) clearTimeout(recheck);
	};
	return { consider };
}
