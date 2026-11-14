/**
 * Whether a stop reaches a write.
 *
 * A stop on one pull request holds every write to that change, and
 * nothing else: the session keeps its other work. A repository, quest or
 * realm holds what is in it, and everything holds every write. Switches
 * and deploys belong to no repository, so only a realm or everything
 * holds them.
 *
 * Where the write leaves something unknown that the stop depends on, a
 * push whose repository git couldn't say, say, the stop holds it and
 * says why. Joel's rule is to lean toward stopping: a write held by
 * mistake waits for a name, while one let through by mistake is someone
 * else's work broken.
 */

import { describeReach, type Reach, type Stop } from "./stops.ts";
import type { Write } from "./writes.ts";

/** What the session making the write is part of. */
export interface Here {
	/** The realm the session is in, when it says. */
	readonly realm?: string;
	/** The quest it has loaded, then that quest's parents, upper-case. */
	readonly quests: readonly string[];
}

/** A stop holding a write, and why it does. */
export interface Held {
	readonly stop: Stop;
	readonly reach: Reach;
	readonly because: string;
}

/** The branch a pull request comes from, when it can be found. */
export type HeadOf = (
	repo: string | undefined,
	pr: number,
) => Promise<string | undefined>;

/** Every stop holding `write`, with the first of its reaches that does. */
export async function covering(
	write: Write,
	stops: readonly Stop[],
	here: Here,
	headOf: HeadOf,
): Promise<Held[]> {
	const held: Held[] = [];
	for (const stop of stops) {
		for (const reach of stop.reaches) {
			const because = await holds(reach, write, here, headOf);
			if (because !== undefined) {
				held.push({ stop, reach, because });
				break;
			}
		}
	}
	return held;
}

/** Why `reach` holds `write`, or undefined when it doesn't. */
async function holds(
	reach: Reach,
	write: Write,
	here: Here,
	headOf: HeadOf,
): Promise<string | undefined> {
	switch (reach.kind) {
		case "everything":
			return "it stops everything";
		case "realm":
			if (here.realm === undefined) return "this session names no realm";
			return here.realm === reach.name
				? `this session is in the ${reach.name} realm`
				: undefined;
		case "quest":
			return here.quests.includes(reach.id)
				? `this session's quest is in ${reach.id}`
				: undefined;
	}
	if (write.kind === "machine") return undefined;
	switch (reach.kind) {
		case "repo":
			if (write.repo === undefined) return "where this goes couldn't be told";
			return sameRepo(reach.repo, write.repo)
				? `it goes to ${write.repo}`
				: undefined;
		case "named":
			return namedIn(reach.name, write, here);
		case "branch":
			return branchHeld(reach, write, headOf);
		case "pr":
			return prHeld(reach, write, headOf);
	}
}

async function prHeld(
	reach: Extract<Reach, { kind: "pr" }>,
	write: Write,
	headOf: HeadOf,
): Promise<string | undefined> {
	const label = describeReach(reach);
	if (
		write.repo !== undefined &&
		reach.repo !== undefined &&
		!sameRepo(reach.repo, write.repo)
	) {
		return undefined;
	}
	if (write.pr !== undefined) {
		return write.pr === reach.number ? `it is ${label}` : undefined;
	}
	if (write.repo === undefined)
		return `which change this touches couldn't be told`;
	if (write.branch === undefined)
		return `which branch of ${write.repo} this touches couldn't be told`;
	const head = await headOf(reach.repo ?? write.repo, reach.number);
	if (head === undefined)
		return `the branch of ${label} couldn't be found to tell it apart`;
	return head === write.branch
		? `${write.branch} is the branch of ${label}`
		: undefined;
}

async function branchHeld(
	reach: Extract<Reach, { kind: "branch" }>,
	write: Write,
	headOf: HeadOf,
): Promise<string | undefined> {
	if (
		write.repo !== undefined &&
		reach.repo !== undefined &&
		!sameRepo(reach.repo, write.repo)
	) {
		return undefined;
	}
	if (write.branch !== undefined) {
		return write.branch === reach.name
			? `it is branch ${reach.name}`
			: undefined;
	}
	if (write.pr !== undefined && write.repo !== undefined) {
		const head = await headOf(write.repo, write.pr);
		if (head === undefined)
			return `the branch of #${write.pr} couldn't be found to tell it apart`;
		return head === reach.name
			? `#${write.pr} comes from ${reach.name}`
			: undefined;
	}
	return `which branch this touches couldn't be told`;
}

/**
 * A bare name ("on aquifer") holds a write whose repository, branch or
 * folder carries it, or a session whose quest does.
 */
function namedIn(name: string, write: Write, here: Here): string | undefined {
	const places = [write.repo, write.branch, write.dir].filter(
		(place): place is string => place !== undefined,
	);
	const found = places.find((place) => place.toLowerCase().includes(name));
	if (found !== undefined) return `${found} is "${name}"`;
	if (here.quests.some((quest) => quest.toLowerCase().includes(name))) {
		return `this session's quest is "${name}"`;
	}
	if (write.repo === undefined && write.dir === undefined)
		return "where this goes couldn't be told";
	return undefined;
}

/** Two repositories alike, where a bare name matches any owner's. */
function sameRepo(stopped: string, written: string): boolean {
	const a = stopped.toLowerCase();
	const b = written.toLowerCase();
	if (a === b) return true;
	return !a.includes("/") && b.split("/").at(-1) === a;
}
