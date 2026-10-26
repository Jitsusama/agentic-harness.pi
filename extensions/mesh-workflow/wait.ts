/**
 * mesh_wait: say what this session's quest has waiting on its person,
 * and say when it no longer waits.
 *
 * One call in place of each quest writing its file by hand with a
 * shell script: it keeps the item where the launcher's Waiting on you
 * reads it (lib/mesh/waiting.ts), and mirrors it in this peer's
 * presence as an `action` want, so its orchestrator and every other
 * peer see it waits on him. The file is the record and outlives the
 * session; presence follows it.
 */

import type { Peer } from "../../lib/mesh/peer.ts";
import {
	addWaiting,
	settleWaiting,
	type WaitingItem,
	waitingOf,
} from "../../lib/mesh/waiting.ts";

/** Where what waits on the person is kept, and whose it is here. */
export interface Waiting {
	/** The folder of every quest's file, which the launcher reads. */
	readonly folder: string;
	/** The quest this session has loaded, if any. */
	quest(): string | undefined;
	/** This session's window, by its exact title, if it has one. */
	window(): string | undefined;
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
	const items = waitingOf(waiting.folder, quest);
	if (items.length > 0) mirror(peer, items, now);
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
	const missing = (["title", "why", "when"] as const).filter(
		(field) => !params[field]?.trim(),
	);
	if (missing.length > 0 || params.minutes === undefined) {
		const all = [
			...missing,
			...(params.minutes === undefined ? ["minutes"] : []),
		];
		return refused(
			`Nothing was kept: an item needs ${all.join(", ")}, so the person can tell what it is, why it is his, how long it takes and when.`,
		);
	}
	if (!Number.isInteger(params.minutes) || params.minutes < 0) {
		return refused(
			`Nothing was kept: minutes is a whole number of minutes, not ${params.minutes}.`,
		);
	}
	const item: WaitingItem = {
		id,
		title: (params.title ?? "").trim(),
		why: (params.why ?? "").trim(),
		minutes: params.minutes,
		when: (params.when ?? "").trim(),
		window: waiting.window() ?? null,
		quest,
		ready: params.ready === true,
	};
	const { before, items } = locked(() => ({
		before: waitingOf(waiting.folder, quest),
		items: addWaiting(waiting.folder, item, now),
	}));
	mirror(peer, items, before.length > 0 ? undefined : now);
	const replaced = before.some((one) => one.id === id);
	return {
		text: `${replaced ? "Replaced" : "Kept"} ${id} as waiting on the person: ${item.title} (${item.minutes} min, ${item.when}). The launcher's Waiting on you shows it${item.ready ? ", with a notice now, since it is ready" : ""}. Say it again with ready: true once he can do it now, and settle it with done: true once it is done.`,
		items,
		written: true,
	};
}

/**
 * Presence says the oldest item still waiting, and how many more; with
 * none left, the want is settled. A want already standing keeps its
 * time, so he sees how long he has been waited on.
 */
function mirror(
	peer: Peer,
	items: readonly WaitingItem[],
	startedAt: Date | undefined,
): void {
	const [first] = items;
	if (!first) {
		peer.settle("action");
		return;
	}
	const standing = peer.wants?.kind === "action" ? peer.wants.since : undefined;
	const since = standing ?? (startedAt ?? new Date()).toISOString();
	const more = items.length > 1 ? ` and ${items.length - 1} more` : "";
	peer.want({ kind: "action", since, said: `${first.title}${more}` });
}

function remaining(items: readonly WaitingItem[]): string {
	return items.length === 0
		? "Nothing else waits on him from this quest."
		: `Still waiting: ${items.map((one) => one.id).join(", ")}.`;
}

function refused(text: string): WaitOutcome {
	return { text, items: [], written: false };
}
