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
 * that peer ends. Two that both sign with it settle it by how long each
 * has: a presence says since when it signs with its quest's address,
 * and the one that has longer keeps it. A peer that took the address
 * while its holder couldn't be heard, as one resuming before the link
 * to the holder's machine is back, gives it back once the holder is
 * heard: on 25 November one such kept it for having the lower session
 * id, and its quest's orchestrator, on another machine, lost its asks.
 * A holder keeps its time through a park, however long, and through a
 * restart in place, a rollover, or a kill or reboot it comes back from
 * within minutes of last saying anything, so none of them hands the
 * address on; one that stopped longer ago than that starts afresh. Where any signer says no time, as
 * an older harness's presence doesn't, the lower session id keeps it as
 * it always did, and where two say the same, the lower id too, so none
 * flips back and forth. Times are each machine's own clock, so a clock wrong by more
 * than the gap between two takings picks the wrong one.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where the quest workflow keeps what addressing reads. */
export interface QuestRecords {
	/** One record per pi session, naming the quest it has loaded. */
	readonly sessions: string;
	/** One folder per quest, each with a README. */
	readonly quests: string;
	/** What each session says it is doing (lib/internal/quest/sessions/doing.ts). */
	readonly doing?: string;
	/** The work broker's records of the trees it cut (internal/work-records.ts). */
	readonly trees?: string;
}

/**
 * What every address is minted as, a quest's six or a session's eight,
 * held loosely to six to eight letters or digits in any case: one line,
 * and nothing after it, since `$` without the `m` flag ends the input.
 */
const SHAPE = /^[A-Za-z0-9]{6,8}$/;

/**
 * Whether a name has an address's shape, in any letters, which a
 * presence read from a file keeps its addresses to. The shape guards
 * printing, not identity: `person` and `machine` have it too, and
 * `isAddress` turns those away, and a well-shaped name another process
 * wrote still reads as whoever it names.
 */
export function isAddressShaped(name: string): boolean {
	return SHAPE.test(name);
}

/**
 * The `from` a machine's mycelium node writes, for what the machine itself
 * must say to a session it holds, as that it leaves at a set time. It is
 * never the person's word, so it carries no act.
 */
export const FROM_MACHINE = "machine";

/**
 * The `from` mycelium's node writes for what the person asked through it,
 * as `mycelium carry` steers each session with.
 */
export const FROM_PERSON = "person";

/**
 * Whether `by` can be a peer's address, in any letters: the one rule
 * for a name a reply or a carry may act on as a peer's. The person's
 * and the machine's own names fit an address's shape, so each is
 * refused by name, in any letters. Here beside the shape, rather than
 * where steers are read, so a reader needing only this pulls in
 * nothing of carries or the machine.
 */
export function isAddress(by: string): boolean {
	const lower = by.toLowerCase();
	return isAddressShaped(by) && lower !== FROM_PERSON && lower !== FROM_MACHINE;
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
	// Its own address goes last, once, though an older list (its own last
	// presence's) already ends with it.
	const kept = older.filter(
		(address) =>
			address !== signing && address !== own && !claimed.has(address),
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
 * one that has signed with it longer than `signsSince`, or, where a time
 * is missing or the same, one whose session id is lower. A session with
 * a time kept from before its restart contests the address before it
 * signs again, but only against signers that say one too.
 */
export function yieldsTo<
	One extends {
		readonly session: string;
		readonly addresses: readonly string[];
		readonly signsSince?: string;
	},
>(
	session: string,
	signing: string | undefined,
	signingNow: boolean,
	live: readonly One[],
	signsSince?: string,
): One | undefined {
	if (signing === undefined) return undefined;
	const signers = live
		.filter((one) => one.session !== session && one.addresses[0] === signing)
		.sort((one, other) => one.session.localeCompare(other.session));
	// Times settle it only when every signer says one: one timeless signer
	// puts all of them back on the old rule, so every peer, old harness or
	// new, ranks the same live set the same way and none of three cycles.
	const since = signsSince;
	if (
		since !== undefined &&
		signers.every((one) => one.signsSince !== undefined)
	) {
		return signers.find(
			(one) =>
				(one.signsSince ?? since) < since ||
				(one.signsSince === since && one.session < session),
		);
	}
	return signers.find((one) => !signingNow || one.session < session);
}

/**
 * Since when a peer signs with its quest's address once its addresses
 * are settled: the time it already held it from, or `now` when it has
 * just taken it, and none once it signs as itself.
 */
export function signingSince(
	signing: string | undefined,
	addresses: readonly string[],
	heldSince: string | undefined,
	now: number,
): { address: string; since: string } | undefined {
	if (signing === undefined || addresses[0] !== signing) return undefined;
	return { address: signing, since: heldSince ?? new Date(now).toISOString() };
}

/**
 * How long before a start its session's last presence may say it ended
 * and still be a restart: a restart in place and a rollover end the old
 * process through the same path a quit does, moments before the new one
 * starts, while a quit reopened later is a new start.
 */
const RESTARTED_WITHIN_MS = 10 * 60_000;

/**
 * The address a session's last presence signed with and since when, when
 * it said a time and stopped no longer than a restart before `now`: what
 * its peer keeps of its holding through its own restart. A session ended
 * for good says when; one killed says nothing, so its last word (`at`)
 * bounds it, lest one back hours after a crash take the address from the
 * peer that held it since. A parked one stays a signer while it sleeps,
 * so nobody took the address meanwhile, and it keeps its time.
 */
export function signedSince(
	presence:
		| {
				readonly addresses: readonly string[];
				readonly signsSince?: string;
				readonly ended?: string;
				readonly at: string;
				readonly state?: string;
		  }
		| undefined,
	now: number,
): { address: string; since: string } | undefined {
	if (presence === undefined) return undefined;
	const address = presence.addresses[0];
	const since = presence.signsSince;
	if (address === undefined || since === undefined) return undefined;
	if (presence.ended === undefined && presence.state === "parked") {
		return { address, since };
	}
	const stopped = Date.parse(presence.ended ?? presence.at);
	return now - stopped <= RESTARTED_WITHIN_MS ? { address, since } : undefined;
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
