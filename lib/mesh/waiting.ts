/**
 * Waiting: what a quest has waiting on its person, kept where the
 * desktop's launcher reads it.
 *
 * Each quest keeps one file, `<folder>/<ADDRESS>.json`, so no session
 * writes another's and none waits on its orchestrator to relay it. The
 * launcher (core.nix's Steward.qml) reads every file in the folder for
 * its Waiting on you, and raises a notice for an item that is ready.
 * The shape is the one `mission-wait` wrote by hand from a shell
 * (core.nix, modules/mission/wait.sh): the quest, when it changed, and
 * its items, each with an id, what it is, why it waits, how many
 * minutes it takes, when, the window it is done in, its quest, and
 * whether he can do it now. The file outlives the session that wrote
 * it, so what waits on him is not lost when a session ends; presence
 * only mirrors it, and only what is ready, since the desktop raises a
 * notice for each want a session's presence says.
 *
 * Each file is written whole under a temporary name beside it and
 * renamed in, so a reader never sees half of one, and a file left with
 * no items is removed.
 *
 * Nobody keeps the list by hand (Joel, 30 October: "shouldn't that be
 * something more automatic"). Each item says how it will be known done,
 * and when ready: a check to run, a signal such as a boot or a switch,
 * or the person saying so where nothing else can tell. A daemon of the
 * desktop's runs the checks and hears the signals, and writes its
 * verdicts to `verdicts.json` beside the folder, which it alone writes;
 * the session's side settles an item done there and marks one ready.
 * An item written before this says nothing of how, and is read as the
 * person's to say.
 */

import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { questAddress } from "./address.ts";
import type { Want } from "./want.ts";

/** The version of a quest's file this writes. */
export const WAITING_VERSION = 2;

/**
 * How an item will be known done, or ready: a command that succeeds
 * once it is, a signal the desktop hears, or the person saying so.
 */
export type Knowing =
	| { readonly check: string }
	| { readonly signal: string }
	| { readonly by: "person" };

/** Where it is done. */
export interface Where {
	/** The machine, by name. */
	readonly machine?: string;
	/** The window, by its exact title. */
	readonly window?: string;
}

/** The session that raised an item. */
export interface Owner {
	readonly session: string;
	readonly address: string;
}

/**
 * The signals an item may wait on: a boot, a switch (any, or to a core
 * commit), a sign-in to a service, a device seen, a file written.
 */
const SIGNAL =
	/^(?:boot|switch(?::[0-9a-f]{7,40})?|signin:[a-z0-9-]+|device:[a-z0-9-]+|file:\/\S+)$/;

/** Whether `signal` is one an item may wait on. */
export function isSignal(signal: string): boolean {
	return SIGNAL.test(signal);
}

/** What an item written before items said how is read as. */
const BY_PERSON: Knowing = { by: "person" };

/** One thing a quest has waiting on its person. */
export interface WaitingItem {
	/** Its own name within the quest, so it can be replaced or settled. */
	readonly id: string;
	/** What he is to do, in a few words. */
	readonly title: string;
	/** Why it waits on him rather than on an agent. */
	readonly why: string;
	/** How many minutes it takes him. */
	readonly minutes: number;
	/** When he can do it, in his words ("now", "tonight", "after 08:00"). */
	readonly when?: string;
	/** The window it is done in, by its exact title, or none, for v 1 readers. */
	readonly window: string | null;
	/** The quest it waits for. */
	readonly quest: string;
	/** Whether he can do it now, which raises a notice. */
	readonly ready: boolean;
	/** How it will be known done. */
	readonly doneWhen: Knowing;
	/** How it will be known ready, when it isn't yet. */
	readonly readyWhen?: Knowing;
	/** The time it is for, if it has one. */
	readonly at?: string;
	/** The time it must be done by, if any. */
	readonly deadline?: string;
	readonly where?: Where;
	/** What he does, step by step, in a few words each. */
	readonly steps?: readonly string[];
	readonly owner?: Owner;
	/** When it was first raised. */
	readonly raisedAt?: string;
}

/** What the desktop's daemon found of one item. */
export interface Verdict {
	readonly state: "done" | "ready";
	readonly at: string;
}

/** The folder of every quest's file, where the launcher reads them. */
export function waitingFolder(
	env: Readonly<Record<string, string | undefined>> = process.env,
	home = homedir(),
): string {
	// An empty XDG_STATE_HOME means the default, as the spec says.
	return join(
		env.XDG_STATE_HOME || join(home, ".local", "state"),
		"mission",
		"waiting",
	);
}

/** Where the daemon keeps its verdicts: beside the folder of files. */
export function verdictsFile(folder: string): string {
	return join(dirname(folder), "verdicts.json");
}

/** The daemon's verdicts, by `<quest>:<id>`, or none while it has none. */
export function verdictsIn(path: string): Map<string, Verdict> {
	const found = new Map<string, Verdict>();
	try {
		const read: unknown = JSON.parse(readFileSync(path, "utf8"));
		const items =
			typeof read === "object" && read !== null && "items" in read
				? read.items
				: undefined;
		if (typeof items !== "object" || items === null) return found;
		for (const [key, value] of Object.entries(items)) {
			if (isVerdict(value)) found.set(key, value);
		}
	} catch {
		// No daemon, or a file being replaced: no verdicts yet.
	}
	return found;
}

/**
 * Settle what the daemon found done and mark ready what it found ready,
 * in `quest`'s file. Answers what waits now, and whether it changed.
 */
export function applyVerdicts(
	folder: string,
	quest: string,
	verdicts: ReadonlyMap<string, Verdict>,
	now = new Date(),
): { items: WaitingItem[]; changed: boolean } {
	const held = waitingOf(folder, quest);
	let changed = false;
	const items = held.flatMap((one): WaitingItem[] => {
		const verdict = verdicts.get(`${quest}:${one.id}`);
		if (verdict?.state === "done") {
			changed = true;
			return [];
		}
		if (verdict?.state === "ready" && !one.ready) {
			changed = true;
			return [{ ...one, ready: true }];
		}
		return [one];
	});
	if (changed) write(folder, quest, items, now);
	return { items, changed };
}

/** Remove what `quest` has waiting, as the quest ends. */
export function clearWaiting(folder: string, quest: string): void {
	rmSync(waitingFile(folder, quest), { force: true });
}

/**
 * The want presence says for what waits: the first item ready, and how
 * many more are, or nothing while none is. An item not ready is kept in
 * the file alone, for the launcher's Waiting on you, since a want in
 * presence raises a notice and he can't do it yet. A want already
 * standing keeps its time, so he sees how long he has been waited on.
 */
export function wantFor(
	items: readonly WaitingItem[],
	standing: string | undefined,
	now: Date,
): Want | undefined {
	const ready = items.filter((one) => one.ready);
	const [first] = ready;
	if (!first) return undefined;
	const more = ready.length > 1 ? ` and ${ready.length - 1} more` : "";
	return {
		kind: "action",
		since: standing ?? now.toISOString(),
		said: `${first.title}${more}`,
	};
}

/** A quest's file, as the launcher reads it. */
interface WaitingFile {
	readonly v: typeof WAITING_VERSION;
	readonly updated: string;
	readonly quest: string;
	readonly items: readonly WaitingItem[];
}

/** The file a quest's items are kept in. */
export function waitingFile(folder: string, quest: string): string {
	return join(folder, `${questAddress(quest)}.json`);
}

/** What a quest has waiting now, oldest first. */
export function waitingOf(folder: string, quest: string): WaitingItem[] {
	try {
		const read: unknown = JSON.parse(
			readFileSync(waitingFile(folder, quest), "utf8"),
		);
		const items = (read as { items?: unknown } | null)?.items;
		return Array.isArray(items)
			? items.filter(isWaitingItem).map((one) => ({
					...one,
					doneWhen: one.doneWhen ?? BY_PERSON,
				}))
			: [];
	} catch {
		// No file, or one being replaced: nothing waits.
		return [];
	}
}

/**
 * Say an item waits, in place of any with its id, so saying it again
 * with `ready` says it has become ready. Answers what waits now.
 */
export function addWaiting(
	folder: string,
	item: WaitingItem,
	now = new Date(),
): WaitingItem[] {
	const held = waitingOf(folder, item.quest);
	const items = held.some((one) => one.id === item.id)
		? held.map((one) => (one.id === item.id ? item : one))
		: [...held, item];
	write(folder, item.quest, items, now);
	return items;
}

/** Say an item no longer waits. Answers what waits now. */
export function settleWaiting(
	folder: string,
	quest: string,
	id: string,
	now = new Date(),
): WaitingItem[] {
	const items = waitingOf(folder, quest).filter((one) => one.id !== id);
	write(folder, quest, items, now);
	return items;
}

function write(
	folder: string,
	quest: string,
	items: readonly WaitingItem[],
	now: Date,
): void {
	const path = waitingFile(folder, quest);
	if (items.length === 0) {
		rmSync(path, { force: true });
		return;
	}
	mkdirSync(folder, { recursive: true });
	const file: WaitingFile = {
		v: WAITING_VERSION,
		updated: now.toISOString(),
		quest,
		items,
	};
	const temporary = join(
		folder,
		`.${questAddress(quest)}.${process.pid}.${now.getTime()}.tmp`,
	);
	writeFileSync(temporary, JSON.stringify(file, null, 2));
	renameSync(temporary, path);
}

/**
 * An item as a file holds it. One written before items said how they
 * are known done has no `doneWhen`, and {@link waitingOf} supplies it.
 */
function isWaitingItem(
	value: unknown,
): value is Omit<WaitingItem, "doneWhen"> & { doneWhen?: Knowing } {
	if (typeof value !== "object" || value === null) return false;
	const one = value as Record<string, unknown>;
	return (
		typeof one.id === "string" &&
		typeof one.title === "string" &&
		typeof one.why === "string" &&
		typeof one.minutes === "number" &&
		(one.when === undefined || typeof one.when === "string") &&
		(one.window === null || typeof one.window === "string") &&
		typeof one.quest === "string" &&
		typeof one.ready === "boolean" &&
		(one.doneWhen === undefined || isKnowing(one.doneWhen))
	);
}

/** Whether `value` says how an item will be known done or ready. */
export function isKnowing(value: unknown): value is Knowing {
	if (typeof value !== "object" || value === null) return false;
	const keys = Object.keys(value);
	if (keys.length !== 1) return false;
	if ("check" in value) {
		return typeof value.check === "string" && value.check.trim() !== "";
	}
	if ("signal" in value) {
		return typeof value.signal === "string" && isSignal(value.signal);
	}
	return "by" in value && value.by === "person";
}

function isVerdict(value: unknown): value is Verdict {
	return (
		typeof value === "object" &&
		value !== null &&
		"state" in value &&
		(value.state === "done" || value.state === "ready") &&
		"at" in value &&
		typeof value.at === "string"
	);
}
