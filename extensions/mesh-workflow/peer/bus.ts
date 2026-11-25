/**
 * What other extensions say over pi's bus that the peer keeps: landings,
 * wants, ended quests, parking and restarts, and what will wake it.
 */

import { carryUnderWay } from "../../../lib/internal/carry/under-way.ts";
import { onConcluded } from "../../../lib/internal/quest/fields/concluded.ts";
import { onDid } from "../../../lib/internal/session/events.ts";
import {
	onClosed,
	onLanded,
	onProposed,
	onUnlanded,
	withoutLanding,
} from "../../../lib/internal/session/landings.ts";
import { onNoModel } from "../../../lib/internal/session/no-model.ts";
import {
	isParkAsk,
	isParking,
	isRestartAsk,
	PARK_ASK,
	PARKING,
	RESTART_ASK,
	SESSION_WOKEN,
} from "../../../lib/internal/session/park.ts";
import {
	isWakersAsk,
	WAKERS_ASK,
} from "../../../lib/internal/session/wakers.ts";
import { onWants } from "../../../lib/internal/session/wants.ts";
import { isCurrent } from "../../../lib/mesh/lease.ts";
import {
	carryProposed,
	keepProposed,
	ownChangesBeside,
} from "../../../lib/mesh/looks/own-changes.ts";
import { type Message, senderIdentity } from "../../../lib/mesh/message.ts";
import { holderSteers } from "../../../lib/mesh/parked.ts";
import type { Peer } from "../../../lib/mesh/peer.ts";
import { sentBy } from "../../../lib/mesh/thread.ts";
import { UNANSWERED_WITHIN_MS } from "../../../lib/mesh/unanswered.ts";
import { waitingOf } from "../../../lib/mesh/waiting.ts";
import { wantFrom } from "../../../lib/mesh/want.ts";
import { tellRepository } from "../landing-notes.ts";
import { ended } from "../talks.ts";
import { meshWakers, type Own } from "../wakers.ts";
import type { Handing } from "./handing.ts";
import { endLooksOfQuests, resolveLooksAt } from "./looks.ts";
import { ledBy, type MeshState } from "./mesh.ts";

/** The message a session is told its own changes went unkept with. */
const OWN_CHANGES_UNKEPT = "mesh-own-changes-unkept";

/**
 * Keep `urls` as proposed under this session's quest, and under the
 * session itself, so a quest's other sessions are refused them and the
 * session still is when its quest's README can't be read; held until
 * the peer is made, as its landings are. A record that can't be written
 * is said once in the session's own words, naming which, since the
 * guard is then only as good as what was kept: a codemode proposal or a
 * rollover slips past it. Each record is tried on its own, so a quest's
 * that fails still leaves the session's, the one a rollover carries.
 * The peer is refreshed first, so a quest loaded since it last looked
 * is the one the change is filed under.
 */
export function keepOwnChanges(m: MeshState, urls: readonly string[]): void {
	if (!m.paths.looks) return;
	if (!m.peer) {
		m.unproposed.push(...urls);
		return;
	}
	const dir = ownChangesBeside(m.paths.looks);
	m.peer.refresh();
	const quest = m.presences.of(m.peer.session)?.quest;
	const owners = [
		...(quest ? [{ owner: quest, what: `quest ${quest}'s record` }] : []),
		{ owner: m.peer.session, what: "this session's own record" },
	];
	for (const { owner, what } of owners) {
		try {
			keepProposed(dir, owner, urls);
		} catch (error) {
			m.pi.sendMessage({
				customType: OWN_CHANGES_UNKEPT,
				content: `The ${what} of what it proposed could not be written (${error instanceof Error ? error.message : String(error)}), so show_person may not refuse it everywhere: never point the person at ${urls.join(", ")}.`,
				display: true,
			});
		}
	}
}

/**
 * Carry what a session kept as proposed under its own id to the fresh
 * log a rollover made of it, under its new id. A record that can't be
 * carried is left: its quest's record still holds it for a quest's
 * session, and the guard falls back to the log for the rest.
 */
export function carryOwnChanges(
	m: MeshState,
	previous: string,
	session: string,
): void {
	if (!m.paths.looks) return;
	try {
		carryProposed(ownChangesBeside(m.paths.looks), previous, session);
	} catch {
		// Said in the doc comment: the quest's record and the log remain.
	}
}

/** Hear what this session's other extensions say over the bus. */
export function onBus(m: MeshState, f: Handing) {
	// What this session waits on its person for, as the session says it
	// over the bus. Heard from load, since a reload with a panel still
	// open says its wants again as the session starts, perhaps before
	// this peer is made; held until then.
	// What this session lands, kept in its presence; held until the peer
	// is made, as its wants are.
	if (m.pi.events) {
		// What it does in its repositories and quests, held the same way.
		onDid(m.pi.events, (event) => {
			if (m.peer) m.peer.did(event);
			else m.undone.push(event);
		});
		onLanded(m.pi.events, (landing) => {
			if (m.peer) {
				// The repository's network hears a change merged, before the
				// presence keeps it, so one said again tells nobody twice.
				const told = tellRepository(m.peer, m.transport, landing);
				if (told) m.seen.add(told.id);
				m.peer.landed(landing);
			} else m.unlanded.push(landing);
			if (landing.url) resolveLooksAt(m.paths.looks, landing.url, "merged");
		});
		// What it proposes is kept per quest, so show_person keeps it off
		// the person's look list past a rollover (lib/mesh/looks/own-changes.ts).
		onProposed(m.pi.events, (urls) => keepOwnChanges(m, urls));
		// A change closed unmerged no longer needs the person either.
		onClosed(m.pi.events, (url) =>
			resolveLooksAt(m.paths.looks, url, "closed"),
		);
		onUnlanded(m.pi.events, (ref) => {
			if (m.peer) m.peer.unlanded(ref);
			else
				m.unlanded.splice(
					0,
					m.unlanded.length,
					...withoutLanding(m.unlanded, ref),
				);
		});
	}

	if (m.pi.events) {
		onWants(m.pi.events, (event) => {
			if (event.said === null) {
				m.wanting.delete(event.kind);
				m.peer?.settle(event.kind);
				return;
			}
			const want = wantFrom(event);
			if (!want) return;
			m.wanting.set(want.kind, want);
			m.peer?.want(want);
		});
	}

	// A session on no model answers nothing it is sent, so its
	// orchestrator hears it from the mesh rather than from its window.
	if (m.pi.events) onNoModel(m.pi.events, f.tellNoModel);
	// A model chosen since: a finding still kept for want of a hub to
	// hear it would now be false, so it is dropped rather than told late.
	m.pi.on("model_select", async () => {
		m.onNoModelUntold = undefined;
	});

	// A quest or document ended: its orchestrator hears it from the mesh,
	// not from whether the session remembers to say so.
	if (m.pi.events) {
		onConcluded(m.pi.events, (event) => {
			f.tellConcluded(event);
			// And the talk that asked for it hears what came of it.
			for (const ref of event.ids) m.talks.came(ended(ref, event.how), ref);
			// What the quest asked of the person ends with it.
			endLooksOfQuests(m.paths.looks, (quest) => event.ids.includes(quest));
		});
	}

	// A restart in place is asked on the bus before its quit, and its
	// ask says by the shutdown whether it restarts (park-workflow).
	m.pi.events?.on(RESTART_ASK, (data: unknown) => {
		if (isRestartAsk(data) && m.peer && data.session === m.peer.session) {
			m.restartAsked = data;
		}
	});

	// A session parking says so in its presence, so senders keep what
	// they send it and wake it; one that holds others off stays.
	m.pi.events?.on(PARKING, (data: unknown) => {
		if (!isParking(data) || !m.peer || data.session !== m.peer.session) return;
		m.peer.park(data.wake);
		data.addresses = m.peer.addresses;
		// A holder that watches them wakes it as a steer lands there.
		if (m.steerRoot !== undefined) {
			data.steers = holderSteers(m.steerRoot, m.peer.addresses);
		}
		const quest = m.presences.of(m.peer.session)?.quest;
		if (quest) data.quest = quest;
	});
	// Parking says so as it starts a session it woke, which may be before
	// or after this extension's own start: read what waited once both
	// have happened.
	m.pi.events?.on(SESSION_WOKEN, () => {
		m.woken = true;
		f.readWhatWaited();
	});
	m.pi.events?.on(PARK_ASK, (data: unknown) => {
		if (!isParkAsk(data) || !m.peer || data.session !== m.peer.session) return;
		// A park or a restart ends the process a carry runs in, and its done
		// file is written last, so neither goes until the carry has ended.
		const carrying = carryUnderWay(data.session);
		if (carrying !== undefined) {
			data.refusals.push(`its work is being carried to ${carrying}`);
		}
		// A restart comes back in seconds as the same peer, and what was
		// sent meanwhile waits in files it reads as it starts; refused for
		// its sessions at work, an orchestrator of thirty never took a new
		// install (WCJQSG, 11 November 2026).
		if (data.restart === true) return;
		// The session at the launcher's top takes his lines, and a parked
		// one took 11 s to wake for each; awake it costs memory, not
		// requests (WCJQSG, 12 November 2026). A run stepping off mid-way
		// would cost him that start too, so it stays.
		if (m.presences.of(m.peer.session)?.standsAtTop) {
			data.refusals.push("it stands at the launcher's top");
		}
		// A park woken as it parks goes on in its host's next start, as a
		// restart comes back: the findings and the hold wait in files it
		// reads as it starts.
		if (data.goesOn === true) return;
		// An orchestrator with sessions at work under it has their findings
		// coming, and passing them on is its work.
		const working = ledAtWork(m.peer);
		if (working) data.refusals.push(working);
		const self = { addresses: m.peer.addresses, ...senderIdentity() };
		const held = m.board
			.all()
			.flatMap((holding) => holding.leases)
			.some((lease) => {
				if (lease.kind !== "wait" || !isCurrent(lease, Date.now())) {
					return false;
				}
				const hold = m.transport.read(lease.subject);
				return hold !== undefined && sentBy(hold, self);
			});
		if (held) data.refusals.push("peers wait on a hold it sent");
	});
	// A session about to rest blocked asks what of its own will wake it.
	m.pi.events?.on(WAKERS_ASK, (data: unknown) => {
		if (!isWakersAsk(data) || !m.peer || data.session !== m.peer.session)
			return;
		const working = ledAtWork(m.peer);
		data.wakers.push(
			...(working ? [working] : []),
			...meshWakers(ownOnMesh(m.peer)),
		);
	});

	/**
	 * The sessions an orchestrator leads that are at work, said as a
	 * phrase, or nothing for any other peer or when none is.
	 */
	const ledAtWork = (one: Peer): string | undefined => {
		if (one.orchestrates === undefined) return undefined;
		// Only sessions still there, as last counted: a presence outlives
		// a pi that crashed or a boot, and on 11 November one of a quest's
		// two and a quest concluded the day before were named at work.
		const working = m.presences
			.all()
			.filter(
				(other) =>
					other.session !== one.session &&
					(m.live?.has(other.session) ?? true) &&
					ledBy(other, one.addresses) &&
					other.state !== "parked" &&
					other.state !== "paused",
			);
		if (working.length === 0) return undefined;
		const names = new Set(working.map((other) => other.addresses[0]));
		return `sessions it leads are at work (${[...names].join(", ")})`;
	};

	// A message's file never changes once it is written, so each is read
	// once here, not again each time the peer rests: the last two hours
	// were over a thousand files, 66 ms of reading on 10 November 2026.
	const recent = new Map<string, Message>();
	const readRecent = (ids: readonly string[]): Message[] => {
		const wanted = new Set(ids);
		for (const id of recent.keys()) if (!wanted.has(id)) recent.delete(id);
		return ids.flatMap((id) => {
			const kept = recent.get(id);
			if (kept) return [kept];
			const message = m.transport.read(id);
			if (!message) return [];
			recent.set(id, message);
			return [message];
		});
	};

	/** What the mesh holds of this peer's own, for what will wake it. */
	const ownOnMesh = (one: Peer): Own => {
		const since = Date.now() - UNANSWERED_WITHIN_MS;
		const everyone = m.presences.all();
		const quest = m.waiting?.quest();
		return {
			session: one.session,
			addresses: one.addresses,
			leases: m.own?.leases ?? [],
			// Ids start with the time they were sent, so older ones go unread,
			// and the days before go unlisted.
			messages: readRecent(
				m.transport
					.idsFromDayOf(`${since}`)
					.filter((id) => !(Number.parseInt(id, 10) < since)),
			),
			aliases: (address) =>
				everyone.find((peer) => peer.addresses.includes(address))
					?.addresses ?? [address],
			items: m.waiting && quest ? waitingOf(m.waiting.folder, quest) : [],
		};
	};
}
