/**
 * mesh_wait: say what this session's quest has waiting on its person,
 * and say when it no longer waits.
 *
 * One call in place of each quest writing its file by hand with a
 * shell script: it keeps the item where the launcher's Waiting on you
 * reads it (lib/mesh/waiting.ts), and mirrors what of it is ready in
 * this peer's presence as an `action` want, so its orchestrator and
 * every other peer see it waits on him now. The desktop raises a notice
 * for each want, so an item not yet ready stays in the file alone. The
 * file is the record and outlives the session; presence follows it.
 *
 * Every item says how it will be known done, so it clears itself: the
 * desktop's daemon runs its check or hears its signal and says so in
 * its verdicts, which this side applies as the session starts and as
 * each run ends. Until the daemon has written any, nothing judges a
 * check or a signal, so the answer says the owner moves the item on
 * itself: on 31 October QGB4ON's item waiting on a switch stayed not
 * ready past that switch, read as a fault in how commits compare.
 */

import { existsSync } from "node:fs";
import type { Peer } from "../../lib/mesh/peer.ts";
import {
	addWaiting,
	applyVerdicts,
	isKnowing,
	type Knowing,
	type Owner,
	settleWaiting,
	verdictsFile,
	verdictsIn,
	type WaitingItem,
	waitingOf,
	wantFor,
} from "../../lib/mesh/waiting.ts";

/** Where what waits on the person is kept, and whose it is here. */
export interface Waiting {
	/** The folder of every quest's file, which the launcher reads. */
	readonly folder: string;
	/** The quest this session has loaded, if any. */
	quest(): string | undefined;
	/** This session's window, by its exact title, if it has one. */
	window(): string | undefined;
	/** This session, as an item it raises names it. */
	owner?(): Owner | undefined;
	/**
	 * Run a change to a quest's file under that quest's lock, so two
	 * sessions on one quest never each drop the other's item. Left out,
	 * the change runs as it is.
	 */
	locked?<T>(quest: string, change: () => T): T;
}

/**
 * Say in presence what the file already holds for this session's quest,
 * as a session starts or takes a quest over: the file outlives the
 * session that wrote it, and presence otherwise says nothing until the
 * next mesh_wait.
 */
export function seedWaiting(
	peer: Peer,
	waiting: Waiting,
	now = new Date(),
): void {
	const quest = waiting.quest();
	if (!quest) return;
	const items = settled(waiting, quest, now);
	if (items.length > 0) mirror(peer, items, now);
}

/**
 * Apply the daemon's verdicts to this session's quest, as a run ends,
 * and say in presence what changed.
 */
export function settleFromVerdicts(
	peer: Peer,
	waiting: Waiting,
	now = new Date(),
): void {
	const quest = waiting.quest();
	if (!quest) return;
	const before = waitingOf(waiting.folder, quest);
	if (before.length === 0) return;
	const after = settled(waiting, quest, now);
	const moved =
		after.length !== before.length ||
		after.some((one, at) => one.ready !== before[at]?.ready);
	if (moved) mirror(peer, after, now);
}

/** What waits for `quest` once the daemon's verdicts are applied. */
function settled(waiting: Waiting, quest: string, now: Date): WaitingItem[] {
	const verdicts = verdictsIn(verdictsFile(waiting.folder));
	if (verdicts.size === 0) return waitingOf(waiting.folder, quest);
	const apply = () => applyVerdicts(waiting.folder, quest, verdicts, now).items;
	return waiting.locked ? waiting.locked(quest, apply) : apply();
}

/** What mesh_wait is given. */
export interface WaitParams {
	readonly id: string;
	readonly title?: string;
	readonly why?: string;
	readonly minutes?: number;
	readonly when?: string;
	readonly ready?: boolean;
	readonly done?: boolean;
	readonly doneWhen?: unknown;
	readonly readyWhen?: unknown;
	readonly at?: string;
	readonly deadline?: string;
	readonly machine?: string;
	readonly steps?: readonly string[];
}

/** What mesh_wait says, and whether it wrote anything. */
export interface WaitOutcome {
	readonly text: string;
	readonly items: readonly WaitingItem[];
	readonly written: boolean;
}

/** Add, replace or settle one item, and mirror what waits in presence. */
export function waitOnPerson(
	peer: Peer,
	waiting: Waiting,
	params: WaitParams,
	now = new Date(),
): WaitOutcome {
	const quest = waiting.quest();
	if (!quest) {
		return refused(
			"Nothing was kept: what waits on the person is kept under a quest, and this session has none loaded. Tell the person in your reply instead.",
		);
	}
	const id = params.id.trim();
	if (id === "")
		return refused("Name the item with `id`, so it can be settled later.");
	const locked = <T>(change: () => T): T =>
		waiting.locked ? waiting.locked(quest, change) : change();
	if (params.done) {
		const settled = locked(() => {
			const held = waitingOf(waiting.folder, quest);
			return held.some((one) => one.id === id)
				? { items: settleWaiting(waiting.folder, quest, id, now), was: true }
				: { items: held, was: false };
		});
		if (!settled.was) {
			return {
				text: `Nothing named ${id} waits for ${quest}; nothing changed.`,
				items: settled.items,
				written: false,
			};
		}
		const items = settled.items;
		mirror(peer, items, now);
		return {
			text: `${id} no longer waits on the person. ${remaining(items)}`,
			items,
			written: true,
		};
	}
	const missing = (["title", "why"] as const).filter(
		(field) => !params[field]?.trim(),
	);
	if (missing.length > 0 || params.minutes === undefined) {
		const all = [
			...missing,
			...(params.minutes === undefined ? ["minutes"] : []),
		];
		return refused(
			`Nothing was kept: an item needs ${all.join(", ")}, so the person can tell what it is, why it is his and how long it takes.`,
		);
	}
	if (!Number.isInteger(params.minutes) || params.minutes < 0) {
		return refused(
			`Nothing was kept: minutes is a whole number of minutes, not ${params.minutes}.`,
		);
	}
	if (!isKnowing(params.doneWhen)) {
		return refused(
			`Nothing was kept: say how it will be known done, so it clears itself, with doneWhen as one of ${KNOWING}.`,
		);
	}
	if (params.readyWhen !== undefined && !isKnowing(params.readyWhen)) {
		return refused(
			`Nothing was kept: readyWhen, when given, is one of ${KNOWING}; leave it out when he can do it now.`,
		);
	}
	const badTime = (["at", "deadline"] as const).find(
		(field) =>
			params[field] !== undefined && Number.isNaN(Date.parse(params[field])),
	);
	if (badTime) {
		return refused(
			`Nothing was kept: ${badTime} is a time, such as 2026-10-31T09:00:00-04:00, not ${params[badTime]}.`,
		);
	}
	const steps = (params.steps ?? []).map((step) => step.trim());
	if (steps.some((step) => step === "")) {
		return refused("Nothing was kept: a step is a few words, never empty.");
	}
	const doneWhen: Knowing = params.doneWhen;
	const readyWhen = isKnowing(params.readyWhen) ? params.readyWhen : undefined;
	const window = waiting.window();
	const machine = params.machine?.trim();
	const owner = waiting.owner?.();
	const { before, items, item } = locked(() => {
		const before = waitingOf(waiting.folder, quest);
		const was = before.find((one) => one.id === id);
		const item: WaitingItem = {
			id,
			title: (params.title ?? "").trim(),
			why: (params.why ?? "").trim(),
			minutes: params.minutes ?? 0,
			...(params.when?.trim() ? { when: params.when.trim() } : {}),
			window: window ?? null,
			quest,
			ready: params.ready ?? readyWhen === undefined,
			doneWhen,
			...(readyWhen ? { readyWhen } : {}),
			...(params.at ? { at: params.at } : {}),
			...(params.deadline ? { deadline: params.deadline } : {}),
			...(window || machine
				? {
						where: {
							...(machine ? { machine } : {}),
							...(window ? { window } : {}),
						},
					}
				: {}),
			...(steps.length > 0 ? { steps } : {}),
			...(owner ? { owner } : {}),
			raisedAt: was?.raisedAt ?? now.toISOString(),
		};
		return { before, item, items: addWaiting(waiting.folder, item, now) };
	});
	mirror(peer, items, before.length > 0 ? undefined : now);
	const replaced = before.some((one) => one.id === id);
	const unjudged = existsSync(verdictsFile(waiting.folder))
		? ""
		: unjudgedOf(item.ready ? undefined : readyWhen, doneWhen);
	return {
		text: `${replaced ? "Replaced" : "Kept"} ${id} as waiting on the person: ${item.title} (${item.minutes} min). The launcher shows it${item.ready ? ", with a notice now, since it is ready" : " under Later until it is ready"}, and it clears itself once ${saidOf(doneWhen)}. Settle it sooner with done: true.${unjudged}`,
		items,
		written: true,
	};
}

/** Presence says what is ready (wantFor), or settles the want. */
function mirror(
	peer: Peer,
	items: readonly WaitingItem[],
	startedAt: Date | undefined,
): void {
	const standing = peer.wants?.kind === "action" ? peer.wants.since : undefined;
	const want = wantFor(items, standing, startedAt ?? new Date());
	if (want) peer.want(want);
	else peer.settle("action");
}

/** The forms doneWhen and readyWhen take, as a refusal says them. */
const KNOWING =
	'{check: "<a command that succeeds once it is so>"}, {signal: "boot" | "switch" | "switch:<core commit, or past it>" | "signin:<service>" | "device:<name>" | "file:<absolute path>"}, or {by: "person"} where nothing else can tell';

/**
 * What the owner must do itself while no daemon judges checks and
 * signals: say it again with ready: true once it is ready, and settle it
 * with done: true once it is done. Nothing for what only the person says.
 */
function unjudgedOf(readyWhen: Knowing | undefined, doneWhen: Knowing): string {
	const judged = (knowing: Knowing | undefined) =>
		knowing !== undefined && !("by" in knowing);
	const moves = [
		...(judged(readyWhen) ? ["say it again with ready: true once it is"] : []),
		...(judged(doneWhen) ? ["settle it with done: true once it is done"] : []),
	];
	return moves.length === 0
		? ""
		: ` Nothing judges checks or signals yet, since the desktop's daemon hasn't written its verdicts, so ${moves.join(", and ")}.`;
}

/** How an item will be known done, in a few words. */
function saidOf(knowing: Knowing): string {
	if ("check" in knowing) return `\`${knowing.check}\` succeeds`;
	if ("signal" in knowing) return `the desktop sees ${knowing.signal}`;
	return "the person says it is done";
}

function remaining(items: readonly WaitingItem[]): string {
	return items.length === 0
		? "Nothing else waits on him from this quest."
		: `Still waiting: ${items.map((one) => one.id).join(", ")}.`;
}

function refused(text: string): WaitOutcome {
	return { text, items: [], written: false };
}
