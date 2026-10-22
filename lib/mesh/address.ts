/**
 * A peer's addresses: the names it signs with and answers to.
 *
 * People already call a session by its quest, the last six letters of
 * the quest id (P9R1KI), so that is a peer's address, and it survives
 * reloads and restores. A peer can have been on several quests, so the
 * one it has loaded comes first and is what it signs with; any other
 * quest whose README lists the session is an older address, so what was
 * sent to it there still arrives. The last eight characters of the
 * session id are always an address too, which is all a peer on no quest
 * has: the last rather than the first, because a pi session id begins
 * with its start time, and sessions started in the same minute shared a
 * first eight.
 *
 * An older address is only ever a fallback. When another peer signs
 * with it, because that quest is now loaded there, it is that peer's
 * and no longer this one's: a session that once held a quest and moved
 * on must not take the messages its successor sends, as its own, nor
 * what is sent to that successor.
 *
 * Two sessions can have one quest loaded at once, as when a second is
 * opened on it. Both signing with its address, each took the other's
 * messages for its own and heard none of them, and they shared one
 * read marker. So the quest's address is one live peer's: a peer that
 * already signs with it keeps it, and one starting while another live
 * peer signs with it signs with its session's address instead, until
 * that peer ends. Two that took it at once settle it by session id,
 * the lower keeping it, so neither flips back and forth.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where the quest workflow keeps what addressing reads. */
export interface QuestRecords {
	/** One record per pi session, naming the quest it has loaded. */
	readonly sessions: string;
	/** One folder per quest, each with a README. */
	readonly quests: string;
}

/** The address a quest gives a peer: its id's last six letters. */
export function questAddress(questId: string): string {
	return (questId.split("-").pop() ?? questId).toUpperCase();
}

/**
 * Every address this session's peer answers to, its signature first.
 *
 * `older` are the addresses of the quests that list it, which reading
 * every README finds, so a caller that asks often passes them in once
 * found; `claimed` are those other peers sign with, which it gives up.
 */
export function addressesOf(
	sessionId: string,
	records: QuestRecords,
	older: readonly string[] = olderAddresses(sessionId, records),
	claimed: ReadonlySet<string> = new Set(),
	yielded = false,
): string[] {
	const own = sessionAddress(sessionId);
	const signing = loadedAddress(sessionId, records);
	const kept = older.filter(
		(address) => address !== signing && !claimed.has(address),
	);
	return [...(signing && !yielded ? [signing] : []), ...kept, own];
}

/**
 * The address a session always has: the last eight characters of its
 * id, the last because a pi session id begins with its start time.
 */
export function sessionAddress(sessionId: string): string {
	return sessionId.replace(/-/g, "").slice(-8).toUpperCase();
}

/** The address of the quest this session has loaded, if it has one. */
export function loadedAddress(
	sessionId: string,
	records: QuestRecords,
): string | undefined {
	const loaded = loadedQuest(sessionId, records.sessions);
	return loaded ? questAddress(loaded) : undefined;
}

/**
 * The live peer this session leaves its quest's address to, if any: one
 * already signing with it, when this session is not; or, when both are,
 * one whose session id is lower.
 */
export function yieldsTo<
	One extends {
		readonly session: string;
		readonly addresses: readonly string[];
	},
>(
	session: string,
	signing: string | undefined,
	signingNow: boolean,
	live: readonly One[],
): One | undefined {
	if (signing === undefined) return undefined;
	return live
		.filter((one) => one.session !== session && one.addresses[0] === signing)
		.sort((one, other) => one.session.localeCompare(other.session))
		.find((one) => !signingNow || one.session < session);
}

/**
 * The addresses of every quest whose README lists this session, which
 * means reading every README: hundreds of them on a long-used machine.
 */
export function olderAddresses(
	sessionId: string,
	records: QuestRecords,
): string[] {
	return questsListing(sessionId, records.quests).map(questAddress);
}

/**
 * The addresses a peer still answers to, given what every peer signs
 * with: its own signature, and none another peer signs with.
 */
export function answeringTo(
	peer: { readonly session: string; readonly addresses: readonly string[] },
	everyone: readonly {
		readonly session: string;
		readonly addresses: readonly string[];
	}[],
): string[] {
	const claimed = signaturesOfOthers(peer.session, everyone);
	return peer.addresses.filter(
		(address, at) => at === 0 || !claimed.has(address),
	);
}

/** What every peer but this session signs with. */
export function signaturesOfOthers(
	session: string,
	everyone: readonly {
		readonly session: string;
		readonly addresses: readonly string[];
	}[],
): Set<string> {
	return new Set(
		everyone
			.filter((one) => one.session !== session)
			.map((one) => one.addresses[0])
			.filter((address): address is string => address !== undefined),
	);
}

/**
 * The peers a message opens by naming, as "P9R1KI: may I…" or
 * "@P9R1KI @WCJQSG the schema…", by the address each signs with: the
 * peers it is for. Sent to a group they share, it would cost every
 * other member its words to learn it was not for them. Nothing when
 * the opening names anything but other peers, as a sender signing its
 * own message ("WCJQSG: the shape suits…") does.
 */
export function namedAtStart(
	text: string,
	session: string,
	everyone: readonly {
		readonly session: string;
		readonly addresses: readonly string[];
	}[],
): string[] {
	const opening =
		/^\s*((?:@?[A-Za-z0-9]+(?:\s*,\s*|\s+and\s+|\s*&\s*|\s+))*@?[A-Za-z0-9]+)\s*:/.exec(
			text,
		)?.[1] ?? /^\s*((?:@[A-Za-z0-9]+[\s,]+)*@[A-Za-z0-9]+)\b/.exec(text)?.[1];
	if (opening === undefined) return [];
	const names = opening
		.split(/\s*,\s*|\s+and\s+|\s*&\s*|\s+/)
		.map((name) => name.replace(/^@/, "").toUpperCase());
	const others = everyone.filter((one) => one.session !== session);
	const meant = names.map(
		(name) =>
			others.find((one) => answeringTo(one, everyone).includes(name))
				?.addresses[0],
	);
	return meant.every((address) => address !== undefined)
		? [...new Set(meant as string[])]
		: [];
}

/** The id of the quest this session has loaded, when its record says. */
export function loadedQuest(
	sessionId: string,
	sessions: string,
): string | undefined {
	try {
		const record: unknown = JSON.parse(
			readFileSync(join(sessions, `${sessionId}.json`), "utf8"),
		);
		const quest = (record as { quest?: unknown } | null)?.quest;
		return typeof quest === "string" ? quest : undefined;
	} catch {
		return undefined;
	}
}

/** Every quest whose README lists this session. */
function questsListing(sessionId: string, quests: string): string[] {
	let ids: string[] = [];
	try {
		ids = readdirSync(quests);
	} catch {
		// No quest store: the session id alone addresses the peer.
	}
	return ids.filter((id) => {
		try {
			return readFileSync(join(quests, id, "README.md"), "utf8").includes(
				sessionId,
			);
		} catch {
			return false;
		}
	});
}
