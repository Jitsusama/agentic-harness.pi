/**
 * Whether a stop parks a session: its run ends at the turn it is on, and
 * nothing new starts until Joel resumes the stop.
 *
 * Parking is for a stop wider than one change. A stop on one pull request
 * or branch parks nobody, since the write guard already holds that change
 * and the session's other work is nobody's concern. A quest parks the
 * sessions on it or under it, a repository those working in it, a realm
 * its sessions, and everything every session.
 *
 * Unlike the write guard this doesn't lean toward stopping where it
 * can't tell: a session whose repositories aren't known isn't parked for
 * a repository, because every write it could make there is still held,
 * and parking it would cost Joel work the stop never asked to end.
 */

import { sameRepo } from "./cover.ts";
import type { Reach, Stop } from "./stops.ts";

/** What a session is part of, as parking reads it. */
export interface Session {
	/** The realm it is in, when it says. */
	readonly realm?: string;
	/** Its quest, then that quest's parents, upper-case. */
	readonly quests: readonly string[];
	/** The repositories its work is in, as `owner/name`. */
	readonly repos: readonly string[];
	/** The folders its work is in: its own, and its trees. */
	readonly dirs: readonly string[];
}

/** A stop parking a session, and why it does. */
export interface Parked {
	readonly stop: Stop;
	readonly reach: Reach;
	readonly because: string;
}

/** Every stop parking `session`, with the first of its reaches that does. */
export function parking(stops: readonly Stop[], session: Session): Parked[] {
	const parked: Parked[] = [];
	for (const stop of stops) {
		for (const reach of stop.reaches) {
			const because = parks(reach, session);
			if (because !== undefined) {
				parked.push({ stop, reach, because });
				break;
			}
		}
	}
	return parked;
}

/** Whether any stop could park a session whose repositories it must ask. */
export function asksRepos(stops: readonly Stop[]): boolean {
	return stops.some((stop) =>
		stop.reaches.some(
			(reach) => reach.kind === "repo" || reach.kind === "named",
		),
	);
}

function parks(reach: Reach, session: Session): string | undefined {
	switch (reach.kind) {
		case "everything":
			return "it stops everything";
		case "realm":
			if (session.realm === undefined) return "this session names no realm";
			return session.realm === reach.name
				? `this session is in the ${reach.name} realm`
				: undefined;
		case "quest":
			return session.quests.includes(reach.id)
				? `this session's quest is in ${reach.id}`
				: undefined;
		case "repo": {
			const repo = session.repos.find((one) => sameRepo(reach.repo, one));
			return repo === undefined ? undefined : `this session works in ${repo}`;
		}
		case "named": {
			const places = [...session.repos, ...session.dirs, ...session.quests];
			const found = places.find((place) =>
				place.toLowerCase().includes(reach.name),
			);
			return found === undefined
				? undefined
				: `this session works in ${found}, which is "${reach.name}"`;
		}
		case "pr":
		case "branch":
			// One change: the write guard holds it, and nobody parks.
			return undefined;
	}
}
