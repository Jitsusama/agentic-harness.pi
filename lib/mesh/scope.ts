/**
 * Scope: the groups a peer is in because of the work it does, rather
 * than because it joined them.
 *
 * Joel wanted the mesh "modeled after communities of growing levels of
 * size", and the swarm quest found that an agent in a single network
 * is a smell. So a peer is born into a group for each level of what it
 * works on, from the narrowest out:
 *
 * - its home, `@ADDRESS` (see group.ts);
 * - its quest, `#quest/<root>/.../<own>`, named down the quest's parent
 *   chain, so a message to `#quest/5gv2ah` reaches every peer on that
 *   quest or a quest under it, as nested groups do;
 * - each repository its work is in, `#repo/<name>`;
 * - the machine, `#all`.
 *
 * Scopes follow the work: loading another quest or adding a tree moves
 * a peer between them, and it cannot leave one while the work is there.
 * What it hears from them is still its own to weigh, at whatever
 * attention it gives.
 */

import { questAddress } from "./address.ts";

/** What a peer's scopes are worked out from. */
export interface Work {
	/** The quest it has loaded, then each parent up to the root. */
	readonly questChain: readonly string[];
	/** The names of the repositories its work is in. */
	readonly repositories: readonly string[];
}

/** The deepest quest group that is written out; deeper is very rare. */
const MOST_QUEST_LEVELS = 6;

/** The groups this work puts a peer in, canonical and sorted. */
export function scopesOf(work: Work): string[] {
	const quest = [...work.questChain]
		.reverse()
		.slice(-MOST_QUEST_LEVELS)
		.map((id) => part(questAddress(id)))
		.filter(Boolean);
	const repositories = work.repositories
		.map(part)
		.filter(Boolean)
		.map((name) => `#repo/${name}`);
	return [
		...new Set([
			...(quest.length > 0 ? [`#quest/${quest.join("/")}`] : []),
			...repositories,
		]),
	].sort();
}

/**
 * A name as one part of a group's path: lower-case letters, digits and
 * dashes, so `agentic-harness.pi` is `agentic-harness-pi`.
 */
export function part(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}
