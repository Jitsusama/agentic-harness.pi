/**
 * mesh_wait: say what this session's quest has waiting on its person,
 * and say when it no longer waits.
 *
 * One call in place of each quest writing its file by hand with a
 * shell script: it keeps the item where the launcher's Needs You reads
 * it (lib/mesh/waiting.ts). The file is the record and outlives the
 * session. It is not said in presence as a want: the session carries
 * on while he does it, so it is still free to answer its peers, and a
 * want there was a second notice of what Needs You already showed.
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
import {
	addWaiting,
	applyVerdicts,
	isKnowing,
	type Knowing,
	markOwner,
	type Owner,
	settleWaiting,
	verdictsFile,
	verdictsIn,
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
	/** This session, as an item it raises names it. */
	owner?(): Owner | undefined;
	/**
	 * Run a change to a quest's file under that quest's lock, so two
	 * sessions on one quest never each drop the other's item. Left out,
	 * the change runs as it is.
	 */
	locked?<T>(quest: string, change: () => T): T;
	/**
	 * Told what waits after this session changed it itself, so its own
	 * settling is never told back to it as news (see watchSettling).
	 */
	heard?(items: readonly WaitingItem[]): void;
}

/** What this session raised, watched for something else settling it. */
export interface SettleWatch {
	/** Take what waits now as known, since this session wrote it. */
	heard(items: readonly WaitingItem[]): void;
	/**
	 * What it raised that settled since it last looked, applying the
	 * daemon's verdicts first. The first look only learns what waits.
	 */
	settled(): WaitingItem[];
	/** Whether anything it raised still waits. */
	watching(): boolean;
}

/**
 * Watch this session's own items for the daemon or the person settling
 * them. Verdicts were applied only as a session started or a run ended,
 * so a session that ended its run Blocked on the person never heard he
 * had done it: since 8 November two sat 32.6 and 14.8 hours so (QCXZEB,
 * 9 November). Items another session raised are its own to hear.
 */
export function watchSettling(waiting: Waiting): SettleWatch {
	let known: { quest: string; items: Map<string, WaitingItem> } | undefined;
	const take = (quest: string, items: readonly WaitingItem[]) => {
		const owner = waiting.owner?.();
		const mine = owner
			? items.filter((one) => one.owner?.session === owner.session)
			: [];
		known = { quest, items: new Map(mine.map((one) => [one.id, one])) };
	};
	return {
		heard(items) {
			const quest = waiting.quest();
			if (quest) take(quest, items);
		},
		settled() {
			const quest = waiting.quest();
			if (!quest) return [];
			settleFromVerdicts(waiting);
			const before = known;
			take(quest, waitingOf(waiting.folder, quest));
			// Another quest's items left with the quest, not with the person.
			if (!before || before.quest !== quest) return [];
			return [...before.items.values()].filter(
				(one) => !known?.items.has(one.id),
			);
		},
		watching: () => (known?.items.size ?? 0) > 0,
	};
}

/** What a session is told when what it raised for the person settles. */
export function settledText(items: readonly WaitingItem[]): string {
	const named = items.map((one) => `${one.id} (${one.title})`).join(", ");
	return `No longer waiting on the person: ${named}. The desktop found ${items.length === 1 ? "it" : "them"} done, or the person cleared ${items.length === 1 ? "it" : "them"}. Carry on with what waited on ${items.length === 1 ? "it" : "them"}.`;
}

/**
 * Apply the daemon's verdicts to this session's quest, as a session
 * starts and as each run ends, settling what is done and marking what
 * is ready.
 */
export function settleFromVerdicts(waiting: Waiting, now = new Date()): void {
	const quest = waiting.quest();
	if (!quest) return;
	if (waitingOf(waiting.folder, quest).length === 0) return;
	const verdicts = verdictsIn(verdictsFile(waiting.folder));
	if (verdicts.size === 0) return;
	const apply = () => applyVerdicts(waiting.folder, quest, verdicts, now);
	if (waiting.locked) waiting.locked(quest, apply);
	else apply();
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

/**
 * Say whether this session still runs for what it raised: ended as it
 * ends, so the launcher doesn't send the person into a session that's
 * gone, and running again as it starts. A file that can't be written
 * now is told at the next start or end.
 */
export function markOwnerRunning(waiting: Waiting, running: boolean): void {
	const quest = waiting.quest();
	const owner = waiting.owner?.();
	if (!quest || !owner) return;
	try {
		const change = () =>
			markOwner(waiting.folder, quest, owner.session, !running);
		if (waiting.locked) waiting.locked(quest, change);
		else change();
	} catch {
		// Said again at this session's next start or end.
	}
}

/** Add, replace or settle one item. */
export function waitOnPerson(
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
		waiting.heard?.(items);
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
	const signin = [params.doneWhen, params.readyWhen].find(awaitsSignin);
	if (signin) {
		return refused(
			`Nothing was kept: nothing says ${signin.signal} yet, since the desktop's daemon hears a sign-in only once something writes ~/.local/state/mission/signins/<service>, and nothing does, so the item would never clear. Give a check that succeeds once he is signed in, or by: "person".`,
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
	// Joel, 8 November: "I have no clue what to act on or even how." An
	// item opens in a drawer of its own, so it has to say how.
	if (steps.length === 0) {
		return refused(
			"Nothing was kept: give the steps he takes, a few words each, so he can act on it without opening this session.",
		);
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
			steps,
			...(owner ? { owner } : {}),
			raisedAt: was?.raisedAt ?? now.toISOString(),
			checkedAt: now.toISOString(),
		};
		return { before, item, items: addWaiting(waiting.folder, item, now) };
	});
	waiting.heard?.(items);
	const replaced = before.some((one) => one.id === id);
	const unjudged = existsSync(verdictsFile(waiting.folder))
		? ""
		: unjudgedOf(item.ready ? undefined : readyWhen, doneWhen);
	return {
		text: `${replaced ? "Replaced" : "Kept"} ${id} as waiting on the person: ${item.title} (${item.minutes} min). The launcher shows it${item.ready ? " in Needs You now, since it is ready" : " under Later until it is ready"}, and it clears itself once ${saidOf(doneWhen)}. Settle it sooner with done: true.${unjudged}`,
		items,
		written: true,
	};
}

/** The forms doneWhen and readyWhen take, as a refusal says them. */
const KNOWING =
	'{check: "<a command that succeeds once it is so, stopped after 90 seconds>"}, {signal: "boot" | "switch" | "switch:<core commit, or past it>" | "device:<name>" | "file:<absolute path>"}, or {by: "person"} where nothing else can tell';

/**
 * Whether a doneWhen or readyWhen waits on a sign-in. The daemon hears
 * one only from a file under ~/.local/state/mission/signins that nothing
 * writes yet (FEH1HE, 9 November), so such an item would never clear.
 * Items already kept with one still read, and wait for the person.
 */
function awaitsSignin(
	knowing: unknown,
): knowing is { readonly signal: string } {
	return (
		isKnowing(knowing) &&
		"signal" in knowing &&
		knowing.signal.startsWith("signin:")
	);
}

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
