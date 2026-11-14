/**
 * The mesh hold a stop sends: to whom, in what words, and when it is
 * renewed or ended.
 *
 * A hold is a request to models, not a gate (the write guard is the
 * gate), but it reaches sessions the guard can't: ones on older code,
 * and ones about to start work a write would end. It also asks each to
 * say what it was doing there, which is what Joel needs to judge the
 * stop. A hold lapses after two hours, and a stop never does, so one
 * standing is renewed well before its hold would lapse.
 *
 * Every hold is sent as {@link HOLD_SENDER}, whichever session sends it,
 * so any session may renew or end one another sent: the mesh lets a
 * message replace another from the same address.
 */

import { ALL } from "../../mesh/group.ts";
import { MOST_HOLD_MS } from "../../mesh/lease.ts";
import { part, scopesOf } from "../../mesh/scope.ts";
import { describeReach, type Reach, type Stop } from "./stops.ts";

/** The address every stop's hold is sent from. */
export const HOLD_SENDER = "PINEAPPLE";

/** How long a hold is left before it is sent again, well inside its two hours. */
export const RENEW_MS = MOST_HOLD_MS - 20 * 60 * 1000;

/** A hold sent for a stop, as kept beside the mesh. */
export interface Kept {
	readonly stop: string;
	/** The hold's id; empty for a shadow stop, which sends nothing. */
	readonly hold: string;
	/** The groups it went to, which its end goes to too. */
	readonly to: readonly string[];
	readonly at: number;
	readonly shadow: boolean;
}

/** What tending the holds does next. */
export type Step =
	| {
			readonly kind: "send";
			readonly stop: Stop;
			readonly to: readonly string[];
			readonly text: string;
			/** The hold this one renews, when there is one to replace. */
			readonly supersedes?: string;
	  }
	| { readonly kind: "end"; readonly kept: Kept; readonly text: string };

/**
 * What to send, renew and end, given the stops standing, the holds kept
 * and the time. A stop reaching only another realm sends nothing here,
 * since that realm's sessions send its hold.
 */
export function tending(
	stops: readonly Stop[],
	kept: readonly Kept[],
	now: number,
	realm: string | undefined,
	chainOf: (quest: string) => readonly string[],
): Step[] {
	const here = stops.filter((stop) => holdsIn(stop, realm));
	const steps: Step[] = [];
	for (const stop of here) {
		const before = kept.find((one) => one.stop === stop.id);
		const due =
			before === undefined ||
			before.shadow !== stop.shadow ||
			now - before.at >= RENEW_MS;
		if (!due) continue;
		steps.push({
			kind: "send",
			stop,
			to: groupsOf(stop, chainOf),
			text: holdText(stop),
			...(before?.hold ? { supersedes: before.hold } : {}),
		});
	}
	for (const one of kept) {
		if (here.some((stop) => stop.id === one.stop)) continue;
		steps.push({ kind: "end", kept: one, text: END_TEXT });
	}
	return steps;
}

/** The groups a stop's hold goes to: the narrowest that reach its work. */
export function groupsOf(
	stop: Stop,
	chainOf: (quest: string) => readonly string[],
): string[] {
	const groups = new Set<string>();
	for (const reach of stop.reaches) {
		for (const group of groupsOfReach(reach, chainOf)) groups.add(group);
	}
	return groups.has(ALL) ? [ALL] : [...groups].sort();
}

function groupsOfReach(
	reach: Reach,
	chainOf: (quest: string) => readonly string[],
): string[] {
	switch (reach.kind) {
		case "quest": {
			const chain = chainOf(reach.id);
			return scopesOf({
				questChain: chain.length > 0 ? chain : [reach.id],
				repositories: [],
			});
		}
		case "repo":
			return [repoGroup(reach.repo)];
		case "pr":
		case "branch":
			return reach.repo === undefined ? [ALL] : [repoGroup(reach.repo)];
		case "everything":
		case "realm":
		case "named":
			return [ALL];
	}
}

function repoGroup(repo: string): string {
	return `#repo/${part(repo.split("/").at(-1) ?? repo)}`;
}

/** Whether a stop's hold is sent in `realm`'s mesh. */
function holdsIn(stop: Stop, realm: string | undefined): boolean {
	return stop.reaches.some(
		(reach) =>
			reach.kind !== "realm" || realm === undefined || reach.name === realm,
	);
}

/** Whether a stop is no wider than one change, which parks nobody. */
function oneChange(stop: Stop): boolean {
	return stop.reaches.every(
		(reach) => reach.kind === "pr" || reach.kind === "branch",
	);
}

/** A hold's words: who stopped what, what that means, and what to say. */
export function holdText(stop: Stop): string {
	const who = stop.saidBy ? `${stop.saidBy} said` : "Someone said";
	const words = stop.words ? ` "${oneLine(stop.words)}"` : "";
	const where = stop.where ? ` (${stop.where})` : "";
	const reaches = stop.reaches.map(describeReach).join(", ");
	const meaning = oneChange(stop)
		? "Pushes, pull-request writes and merges to it are refused while it stands; carry on with other work. If you were working on it, answer this hold saying what you were doing there."
		: "Pushes, pull-request writes and merges there are refused while it stands, and sessions in it are parked. Leave that work where it is, and answer this hold saying what you were doing there.";
	return `Joel's safe word: ${who}${words}${where}, stopping ${reaches}. Only Joel resumes it. ${meaning}`;
}

/** What ends a hold, once Joel has resumed its stop. */
export const END_TEXT =
	"Joel resumed this safe-word stop: its writes may go again. Before writing where it stood, check what changed while it did.";

/** How much of a stop's words a hold quotes. */
const WORDS_SHOWN = 200;

function oneLine(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > WORDS_SHOWN
		? `${flat.slice(0, WORDS_SHOWN - 3)}...`
		: flat;
}
