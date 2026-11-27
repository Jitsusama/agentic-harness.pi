/**
 * Hearing the mesh: who is still there, taking each message once, judging
 * what attention it gets here, and chasing what went unanswered.
 *
 * Long because taking a message live, catching up on what was missed and
 * routing both share one read front, one marker and what was withdrawn
 * meanwhile, so a split by reason would pass that state between files;
 * the catch-up may move out once it no longer needs the live route's.
 */

import { singleFlight } from "../../../lib/internal/process/single-flight.ts";
import { blockedLine, lastRun } from "../../../lib/internal/session/ending.ts";
import { firstPromptPending } from "../../../lib/internal/session/first-prompt.ts";
import { namesLanding } from "../../../lib/internal/session/landings.ts";
import { askWake, isParked } from "../../../lib/internal/session/park.ts";
import { settledWithin } from "../../../lib/internal/settled.ts";
import {
	attend,
	type Concern,
	concernFrom,
	concernQuestionFor,
	concernState,
	type Heed,
	mentions,
	type Receiver,
} from "../../../lib/mesh/attention.ts";
import { caughtUp, MOST_CAUGHT_UP } from "../../../lib/mesh/damping.ts";
import { flowsAt } from "../../../lib/mesh/flow.ts";
import { groupNamed, homeOf, isJoinable } from "../../../lib/mesh/group.ts";
import { awaitedSessions, changesOf } from "../../../lib/mesh/lease.ts";
import { census } from "../../../lib/mesh/liveness.ts";
import {
	asksEach,
	clock,
	isHomeTo,
	type Message,
	reaches,
	senderIdentity,
	shortId,
} from "../../../lib/mesh/message.ts";
import { nodeSocket, servedAt } from "../../../lib/mesh/node.ts";
import { ASK_AGAIN_MS } from "../../../lib/mesh/owed.ts";
import { wakeForCarriedIn, wakeSteered } from "../../../lib/mesh/parked.ts";
import {
	joinRefused,
	MOST_GROUPS,
	type Presence,
	roomToBringBack,
	roomToJoin,
} from "../../../lib/mesh/presence.ts";
import { seenAtStart } from "../../../lib/mesh/reading.ts";
import {
	readsAsReceptor,
	type Unvouched,
	unvouched,
	VOUCH_AGAIN_MS,
	vouchedOnly,
} from "../../../lib/mesh/receptor.ts";
import type { Judge } from "../../../lib/mesh/routing.ts";
import { isStopped } from "../../../lib/mesh/stop.ts";
import {
	answers,
	answersQuestion,
	depthOf,
	mayReplace,
	type Self,
	sentBy,
} from "../../../lib/mesh/thread.ts";
import { dayOf, readEachOff } from "../../../lib/mesh/transport.ts";
// How long a message heard may take to judge, as a send may: the same
// classifier over the same network, so one bound serves both.
import { JUDGE_MS } from "../../../lib/prose/claims.ts";
import { NOTED, UNVOUCHED } from "../delivery.ts";
import { takenAtNextLook } from "../steer.ts";
import type { Handing } from "./handing.ts";
import {
	answeringAt,
	delivered,
	type Heeded,
	LEFT_MS,
	ledBy,
	type MeshState,
	STOPPED,
} from "./mesh.ts";

/** Wakes kept to tell a later ask from a first, before they are let go. */
const MOST_ASKED = 1000;

/**
 * The parked peers each message carried in was asked to wake, by any
 * hearing in this process: every running peer judges every arrival, and
 * a host runs many, whose holder would otherwise be asked the same wake
 * once a conversation.
 */
const askedWakes = new Set<string>();

/** Ask `session`'s holder to wake it for `messageId`, once a process. */
function askWakeOnce(session: string, messageId: string): void {
	const asked = `${session} ${messageId}`;
	if (askedWakes.has(asked)) return;
	askWake(session, messageId);
	if (askedWakes.size >= MOST_ASKED) askedWakes.clear();
	askedWakes.add(asked);
}

/**
 * What a start's catch-up holds the read front with while it lists, an
 * id below every message's, so nothing handed over meanwhile is passed.
 */
const LISTING = "";

/** Whether an id was stamped on a day before another's, both in time. */
function dayBefore(id: string, other: string): boolean {
	const day = dayOf(id);
	const otherDay = dayOf(other);
	return day !== undefined && otherDay !== undefined && day < otherDay;
}

/** How this peer hears and routes what reaches it. */
export function createHearing(m: MeshState, f: Handing) {
	/**
	 * The run end whose `Blocked:` line last woke this peer: one wake a
	 * blocked run, so news after it waits for a run to end blocked again.
	 */
	let wokeFor: string | undefined;

	/** Count who is live, of `everyone` when a clock has just listed them. */
	const countLive = async (everyone?: readonly Presence[]) => {
		try {
			const { present } = await census(everyone ?? m.presences.all());
			m.live = new Set(present.map((one) => one.session));
		} catch {
			// Uncounted, the last count stands.
		}
	};

	/**
	 * Who the live peers are parked on, for the machine queue to give
	 * their heavy work its turn first (see lib/internal/priority/awaited.ts).
	 */
	const awaited = () =>
		awaitedSessions(
			m.board.all(),
			// This peer is there whether or not it was counted yet.
			m.presences
				.all()
				.filter(
					(one) =>
						one.session === m.peer?.session ||
						(m.live?.has(one.session) ?? true),
				),
		);

	const askFlows = () => {
		m.flows = flowsAt(nodeSocket(m.env));
	};

	/**
	 * Tell both sides when this peer leaves its quest's address to a
	 * live peer that already signs with it: two sessions on one quest
	 * are how work gets done twice, so each is asked to say what it
	 * takes. A change of signature is said on screen.
	 */
	const identity = () => {
		if (!m.peer) return;
		const holder = m.peer.yieldedTo;
		const quest = holder?.addresses[0];
		if (holder && quest && holder.session !== m.leftTo) {
			const sig = m.peer.signature;
			const message = m.transport.send({
				from: sig,
				to: [homeOf(quest)],
				intent: "fyi",
				text: `${sig} has quest ${quest} loaded too. ${quest} stays this peer's address and ${sig} signs as itself; both hear the quest's group. Say which part of the quest each is taking, so neither repeats the other's work.`,
				...senderIdentity(),
			});
			m.seen.add(message.id);
			m.pi.sendMessage(
				{
					customType: NOTED,
					content: `Another live session, ${quest}, already has this quest loaded and signs with its address, so this peer signs as ${sig} until it ends; both hear the quest's group, and ${quest} has been told. Before starting on the quest, see what ${quest} is on (mesh_groups) and agree with it which part each takes, so neither repeats the other's work.`,
					display: true,
					details: { ...delivered([], []), leftTo: holder.session },
				},
				{ triggerTurn: false },
			);
		}
		m.leftTo = holder?.session;
		if (
			m.signed !== undefined &&
			m.signed !== m.peer.signature &&
			m.ctx?.hasUI
		) {
			m.ctx.ui.notify(
				`Mesh: this peer signs as ${m.peer.signature} now`,
				"info",
			);
		}
		m.signed = m.peer.signature;
	};

	/** The session's classifier, if it is found in time to judge with. */
	const classifierWithin = () =>
		m.classifier ? settledWithin(m.classifier, JUDGE_MS) : undefined;

	/** Whose business a message is, by the classifier, or nothing. */
	const judge = async (
		message: Message,
		receiver: Receiver,
	): Promise<Concern | undefined> => {
		// What is sent to this peer is noted whatever it says, so asking
		// about it would spend a call on an answer nothing reads.
		if (isHomeTo(message, receiver.addresses)) return undefined;
		// What the words already show needs no classifier: naming this peer
		// or what it owns is about its work.
		if (mentions(message, receiver)) return "receiver";
		try {
			const found = await classifierWithin();
			if (!found?.ok) return undefined;
			const result = await settledWithin(
				found.classify(
					{
						state: concernState(message, receiver),
						questions: concernQuestionFor(receiver),
					},
					AbortSignal.timeout(JUDGE_MS),
				),
				JUDGE_MS,
			);
			return result?.stopReason === "stop"
				? concernFrom(result.answers.about)
				: undefined;
		} catch {
			// An unjudged message is noted, which is never wrong for long.
			return undefined;
		}
	};

	/**
	 * The classifier's pick of a group for a message its sender named
	 * none for, or nothing, in which case it is routed by rule.
	 */
	const routing: Judge = async (context) => {
		const found = await classifierWithin();
		if (!found?.ok) return undefined;
		const result = await settledWithin(
			found.classify(context, AbortSignal.timeout(JUDGE_MS)),
			JUDGE_MS,
		);
		return result?.stopReason === "stop" ? result.answers.to : undefined;
	};

	// What a withdrawal heard while a start caught up handed over in its
	// place: the catch-up, reading off the thread, would else hand the
	// message withdrawn over after what withdrew it.
	let withdrawnMeanwhile = new Set<string>();

	/**
	 * The attention each message gets here, judged together. Starting,
	 * it is a catch-up: nothing takes a turn, and a long one is held to what
	 * a peer starting can take in.
	 */
	const route = async (arrived: readonly Message[], starting = false) => {
		if (arrived.length === 0 || !m.ctx || !m.peer) return;
		// The peer this was routed for: a session that ends while it is
		// judged leaves the rest undone (see session_shutdown).
		const routedFor = m.peer;
		// Only the node speaks as a receptor, but anything the account writes
		// lands in the folder, so one under a receptor's name is shown only
		// when the node serves it as written, and dropped, said in the log,
		// otherwise. A batch holding none never waits on the node; one that
		// does waits as a whole, so its messages keep their order: the node
		// is asked, then again after each of VOUCH_AGAIN_MS, each ask given
		// its patience. A catch-up asks again once only, since what it
		// reads was written before this session started, so the node has
		// long had it, and a planted file holds back its first turn no
		// longer than it must. One dropped is handed
		// over as needing nothing more, or the read marker would stop
		// behind it for the rest of the session. Drops are said once the
		// wait is over, and only to the session they were routed for, since
		// one that ended or switched meanwhile has no log of its own here.
		const drops: [Message, Unvouched][] = [];
		const messages = arrived.some((one) => readsAsReceptor(one.from))
			? await vouchedOnly(
					arrived,
					(ids) => servedAt(nodeSocket(m.env), ids),
					(message, why) => drops.push([message, why]),
					starting ? VOUCH_AGAIN_MS.slice(0, 1) : VOUCH_AGAIN_MS,
				)
			: arrived;
		if (m.peer !== routedFor) return;
		for (const [message, why] of drops) {
			m.pi.appendEntry(UNVOUCHED, {
				id: message.id,
				from: message.from,
				why: unvouched(message.from, message.id, why),
			});
		}
		if (drops.length > 0) f.handedOver(drops.map(([message]) => message));
		if (messages.length === 0 || !m.ctx) return;
		m.peer.refresh();
		identity();
		// What it changes now tells its business from another's best.
		const receiver: Receiver = {
			...m.peer.receiver,
			changing: changesOf(m.board.of(m.peer.session)?.leases ?? []),
		};
		const self: Self = { addresses: m.peer.addresses, ...senderIdentity() };
		const listener = m.peer.listener;
		// Every address the orchestrator signs with, so a pivot under
		// either its quest's or its session's is known as its own.
		const orchestrator = m.peer.orchestratedBy
			? addressesOf(m.peer.orchestratedBy)
			: undefined;
		const read = (id: string) => m.transport.read(id);
		const everyone = m.presences.all();
		const stopped = messages.map((message) =>
			isStopped(message, m.peer?.stops ?? [], everyone),
		);
		const answering = messages.map((message) => answers(message, read, self));
		// What an orchestrator can read from a sender's presence rather than
		// its message: only an orchestrator is spared, since only it is sent
		// status (RSCH-20261031-GUDOJV, piece 1).
		const restating = messages.map(
			(message) =>
				m.peer?.orchestrates !== undefined &&
				message.intent === "fyi" &&
				namesLanding(
					message.text,
					everyone.find((one) => one.addresses.includes(message.from))
						?.landings ?? [],
				),
		);
		const led = messages.map(
			(message) =>
				routedFor.orchestrates !== undefined &&
				ledBy(
					everyone.find((one) => one.addresses.includes(message.from)),
					routedFor.addresses,
				),
		);
		const asked = messages.map((message) =>
			answersQuestion(message, read, self),
		);
		const concerns = await Promise.all(
			messages.map((message, at) =>
				// A peer hearing only what is put to it glances at the rest
				// whatever the classifier says, so it isn't asked.
				stopped[at] ||
				answeringAt(answering, at) ||
				receiver.hears === "addressed"
					? undefined
					: judge(message, receiver),
			),
		);
		if (m.peer !== routedFor) return;
		// Never while starting: the first prompt is about to run, and pi
		// refuses a second turn asked for beside it.
		const idle = !starting && (m.ctx.isIdle?.() ?? false);
		// An idle peer whose run ended blocked on a peer waits on that peer's
		// next word, sent to it however it is sent, once a run. Only a peer
		// present here counts, by the addresses its presence gives, so a stray
		// word a line holds, such as "main", names nobody. That guards against
		// a name, not a forger: a `from` is only what the sender wrote, as
		// everywhere on the mesh. One from another realm is another principal
		// (unanswered.ts), never the peer named here.
		const ended = idle ? lastRun(m.ctx.sessionManager) : undefined;
		const blocked =
			ended && ended.id !== wokeFor ? blockedLine(ended.text) : undefined;
		const awaiting = messages.map((message) => {
			if (blocked === undefined || message.fromRealm !== undefined) {
				return false;
			}
			const sender = everyone.find((one) =>
				one.addresses.includes(message.from),
			);
			return (
				sender !== undefined &&
				mentions({ text: blocked }, { addresses: sender.addresses, owns: [] })
			);
		});
		const raisedAll: Heed[] = messages.map((message, at) => {
			const replaced = replacedBy(message);
			if (replaced) {
				// A question withdrawn is owed no answer, so it is never asked
				// again, nor taken up once another peer lets it go; and so even
				// when its sender has since been stopped, whose withdrawal is
				// otherwise only a glance.
				m.owing.withdrawn(replaced.id);
				m.left.delete(replaced.id);
				m.glances.drop(replaced.id);
				m.acts?.drop((one) => one.message.id === replaced.id);
				f.handedOver([replaced]);
				withdrawnMeanwhile.add(replaced.id);
			}
			// Stopped is absolute: a line, never more, whatever it is.
			if (stopped[at]) return { attention: "glance", why: STOPPED };
			const judged = attend(message, {
				receiver,
				idle,
				answers: answeringAt(answering, at),
				asked: answeringAt(asked, at),
				...(awaiting[at] ? { awaits: true } : {}),
				askedEach: asksEach(message, listener),
				now: Date.now(),
				...(restating[at] ? { restates: true } : {}),
				...(led[at] ? { led: true } : {}),
				...(orchestrator ? { orchestrator } : {}),
				...(concerns[at] ? { concern: concerns[at] } : {}),
			});
			// What a starting peer catches up on rides the first prompt. A
			// peer started with none, as a parked one is woken by a message,
			// has no turn coming but this one: on 6 November a question
			// that woke one was only noted, owed nothing, and the peer
			// parked again with it unanswered.
			const worth: Heed =
				starting && judged.attention === "turn" && firstPromptPending()
					? { attention: "note", why: judged.why }
					: judged;
			// A withdrawal reaches in full everyone who heard what it
			// withdraws, and what it withdraws is never handed over after it.
			// A peer hearing only what is put to it glanced at the original,
			// so a glance takes its place.
			const heard =
				replaced !== undefined &&
				receiver.hears !== "addressed" &&
				reaches(replaced, listener, senderIdentity().pid);
			return heard && worth.attention === "glance"
				? { attention: "note", why: "replacing what this peer heard" }
				: worth;
		});
		const homes = m.peer.addresses.map(homeOf);
		const raisedEach =
			starting && messages.length > MOST_CAUGHT_UP
				? caughtUp(
						messages.map((message, at) => ({
							message,
							heed: raisedAll[at] as Heed,
							own:
								message.intent === "hold" ||
								answeringAt(answering, at) ||
								answeringAt(asked, at) ||
								message.to.some((group) => homes.includes(group)),
						})),
					)
				: raisedAll;
		const damped: string[] = [];
		const inFull: Message[] = [];
		const heeded: Heeded[] = messages.map((message, at) => {
			const raised = raisedEach[at] as Heed;
			const heed = m.damper.damp(
				message,
				raised,
				depthOf(message, read),
				Date.now(),
				inFull,
			);
			if (heed.attention !== raised.attention) damped.push(heed.why);
			if (heed.attention !== "glance") inFull.push(message);
			return { message, heed };
		});
		f.say(damped);
		if (heeded.some(({ heed }) => heed.unblocks && heed.attention === "turn")) {
			wokeFor = ended?.id;
		}
		for (const { message, heed } of heeded) {
			if (heed.attention === "glance") f.glance(message, heed.why);
			if (heed.attention === "act") m.acts?.add({ message, heed });
		}
		const now = heeded.filter(
			({ heed }) => heed.attention === "note" || heed.attention === "turn",
		);
		f.note(
			now,
			now.some(({ heed }) => heed.attention === "turn"),
		);
	};

	/** The earlier message this one validly replaces, if any. */
	const replacedBy = (message: Message): Message | undefined => {
		if (message.supersedes === undefined) return undefined;
		const original = m.transport.read(message.supersedes);
		return original && mayReplace(message, original) ? original : undefined;
	};

	/**
	 * Whether this id is for this peer to read now, marked seen first so
	 * that nothing else takes it meanwhile.
	 */
	const claim = (id: string): boolean => {
		if (m.seen.has(id) || !m.peer) return false;
		m.seen.add(id);
		// From a day before the catch-up's, so only an old copy written back
		// at the top: passed by unread, as the catch-up passes its day. A
		// week written back, about 48,000 files on 14 November, would have
		// every session read and parse each in one burst.
		return !(m.caughtUpFrom !== undefined && dayBefore(id, m.caughtUpFrom));
	};

	/** A message as it lands, read on the thread, as one alone is. */
	const take = (id: string): Message | undefined =>
		// As it lies, since route asks the node to vouch for one under a
		// receptor's name; until then it ends no hold and answers nothing.
		claim(id) ? taken(id, m.asWritten(id)) : undefined;

	// A look asked for while the start caught up, owed once it is done.
	let lookPassedOver = false;

	/**
	 * What reaches this peer since `since`, listed and read off the
	 * thread: on 26 November one start's catch-up, read a file at a time
	 * on it, held its host's every conversation for 32 s. Nothing, when
	 * the peer started again meanwhile and reads afresh.
	 *
	 * Each id is taken on the front as it is claimed, before its read, so
	 * a message heard meanwhile is routed at once without carrying the
	 * marker past one still being read; those that turn out not to be
	 * handed over are let go once read. None is let go when listing or
	 * taking them throws: held, they keep the marker where it was for the
	 * rest of the session, so the next start catches up on them, rather
	 * than passing them by unshown for good, already seen here.
	 */
	const catchUp = async (since: string): Promise<Message[]> => {
		const front = m.front;
		// Overtaken by a start in this runtime, which makes a front of its
		// own, or by its session's end, a reload's among them, which leaves
		// no peer: either way it is no longer this start's to read.
		const startedFor = m.peer;
		const standing = () => m.front === front && m.peer === startedFor;
		lookPassedOver = false;
		withdrawnMeanwhile = new Set();
		const withdrawn = withdrawnMeanwhile;
		// Held, before anything here waits, until what it lists is taken:
		// a message the watcher handed over while it listed would else carry
		// the marker past the backlog not yet claimed, which a restart then
		// never caught up on.
		front.taken(LISTING);
		// The top listed once for both: twice at once, it was the slowest
		// step of a start.
		const listed = await m.transport.listFromDayOf(since);
		if (!standing()) return [];
		for (const id of seenAtStart(listed.top, since)) m.seen.add(id);
		const claimed = listed.ids.filter((id) => id > since && claim(id));
		for (const id of claimed) front.taken(id);
		letGo([LISTING]);
		// Read no further once overtaken: a restart would else read the
		// same backlog twice at once, the very load it spreads.
		const written = await readEachOff(
			{ readOff: m.asWrittenOff },
			claimed,
			standing,
		);
		if (!standing()) return [];
		const caught = claimed
			.map((id, at) => taken(id, written[at]))
			.map((one) => (one && withdrawn.has(one.id) ? undefined : one));
		letGo(claimed.filter((_, at) => caught[at] === undefined));
		return caught.filter((one): one is Message => one !== undefined);
	};

	/**
	 * These were taken but are not to be handed over, so the marker passes
	 * them, and those handed behind them meanwhile.
	 */
	const letGo = (ids: readonly string[]) => {
		const to = m.front.letGo(ids);
		if (to !== undefined && m.peer) m.transport.markRead(m.peer.signature, to);
	};

	/**
	 * A claimed message, as it was read: what it ends and answers counted,
	 * and the message itself when it reaches this peer.
	 */
	const taken = (
		id: string,
		read: Message | undefined,
	): Message | undefined => {
		if (!m.peer) return undefined;
		// A file caught half written reads as nothing: the next look takes
		// it again rather than counting it seen and losing it for good.
		if (!read) m.seen.delete(id);
		// One whose envelope names another id is no message of this file's,
		// and passed by as seen: the front is held by file and handed by
		// envelope, so handing it would let go another's hold, the
		// catch-up's listing among them.
		const written = read?.id === id ? read : undefined;
		const message =
			written && !readsAsReceptor(written.from) ? written : undefined;
		// Woken for before what reaches this peer is sorted out, since a
		// question carried in to a parked peer's own home reaches no peer
		// running here. Not held to this peer's catch-up mark, since mail
		// carried in late keeps its sender's older stamp: the parked peer's
		// own marker passes over what it read, and the clock what lapsed.
		if (message) wakeForElsewhere(message);
		// A hold this peer waits on can end in a message to a group it does
		// not hear, so ends are looked for before what reaches it.
		const end = message ? m.leasing.ended(message) : undefined;
		if (end) m.resumes?.add(end);
		// Answers are counted wherever they went, so a question to a group
		// one peer took up is known as answered by every other.
		if (
			message?.re !== undefined &&
			!sentBy(message, { addresses: m.peer.addresses, ...senderIdentity() })
		) {
			m.answered.add(message.re);
			m.awaiting.answered(message.re, () => addressesOf(message.from));
		}
		if (!written || !reaches(written, m.peer.listener, senderIdentity().pid)) {
			return undefined;
		}
		// An old copy written back at the top, as a link to another machine
		// does, is counted above but never handed over. On 14 November one
		// wrote a week of expired messages back, and every session took
		// each as new, its questions and pivots with a turn.
		if (m.caughtUpFrom !== undefined && id <= m.caughtUpFrom) return undefined;
		// The marker passes it only once it is handed over (see reading.ts).
		m.front.taken(id);
		// One under a receptor's name brings nobody into a group either.
		if (!message) return written;
		// Brought into a group by another peer: it joins without being
		// asked, as Joel wants agents to organise themselves, and the note
		// it gets says how to leave.
		if (
			message.invite !== undefined &&
			!isStopped(message, m.peer.stops, m.presences.all()) &&
			isHomeTo(message, m.peer.addresses) &&
			groupNamed(message.invite) === message.invite &&
			message.invite.startsWith("#") &&
			isJoinable(message.invite)
		) {
			// Too full to join, it is told so beside an invite that says it
			// is in the group now, which it then is not. One that hears the
			// group already through a part of it is told nothing more, and one
			// that joined it and set it aside is told it waits for room.
			if (m.peer.setAside.includes(message.invite)) {
				return {
					...message,
					text: `${message.text} It joined ${message.invite} before, but set it aside: its work's groups leave no room among the ${MOST_GROUPS} a peer may be in, so it hears nothing there yet. To hear it, ${roomToBringBack(m.peer.setAside, message.invite)}.`,
				};
			}
			if (joinRefused(m.peer.groups, message.invite) === "full") {
				return {
					...message,
					text: `${message.text} It couldn't join ${message.invite}, though: it is in ${MOST_GROUPS} groups, the most a peer may be in, so ${roomToJoin(m.peer.setAside)}, then join with mesh_join.`,
				};
			}
			m.peer.join(message.invite);
			// A join its work's groups leave no room for is set aside at
			// once, so the invite's "in the group from now on" isn't so yet.
			if (m.peer.setAside.includes(message.invite)) {
				return {
					...message,
					text: `${message.text} It joined ${message.invite}, but set it aside at once: its work's groups leave no room among the ${MOST_GROUPS} a peer may be in, so it hears nothing there until there is room, when the set-aside group that sorts first comes back by itself. mesh_groups says which it set aside.`,
				};
			}
		}
		return message;
	};

	/**
	 * Questions left to a peer that took them up, waiting to act here
	 * after all once it lets one go unanswered: its run ended, or it did,
	 * with no answer sent. Every other peer had stood aside, so a question
	 * one took up and dropped was otherwise answered by nobody.
	 */
	const reconsider = async () => {
		const now = Date.now();
		for (const [id, one] of [...m.left]) {
			if (m.answered.has(id) || now - Date.parse(one.message.at) > LEFT_MS) {
				m.left.delete(id);
				continue;
			}
			const still = await m.leasing.answeredBy(one.message).catch(() => one.by);
			if (still !== undefined || !m.left.delete(id) || !m.acts) continue;
			m.acts.add({
				message: one.message,
				heed: {
					...one.heed,
					why: `${one.heed.why}, let go unanswered by ${one.by}`,
				},
			});
		}
	};

	/** The addresses of the peer signing as this, as far as presence says. */
	const addressesOf = (from: string): readonly string[] =>
		m.presences.all().find((one) => one.addresses.includes(from))
			?.addresses ?? [from];

	/**
	 * Questions put to this peer that it hasn't answered, handed again
	 * with a turn; and questions it put that are stuck, said on screen
	 * and to its model, once each.
	 */
	const chase = () => {
		// A busy session reads what it was handed when pi gets to it, one
		// at a time; asking again meanwhile only queues reminders that
		// arrive after the answer they ask for. Its run ending unanswered
		// is what the asking again is for.
		const again = (m.ctx?.isIdle?.() ?? true) ? m.owing.due() : [];
		if (again.length > 0) {
			const minutes = Math.round(ASK_AGAIN_MS / 60_000);
			f.note(
				again.map(({ message }) => ({
					message,
					heed: {
						attention: "turn",
						why: "asked again, unanswered",
						addressed: true,
					},
				})),
				true,
				`Asked again: ${again.length === 1 ? "this question was" : "these questions were"} put to you at least ${minutes} minutes ago and you have sent no answer. Answer now with mesh_send, re set to its id, or say when you will.`,
			);
		}
		const stuck = m.awaiting.stuck();
		if (stuck.length === 0) return;
		const lines = stuck.map(
			({ message, waitingOn }) =>
				`Your question [${shortId(message)}] from ${clock(message)} has had no answer from ${waitingOn.join(", ")}. It has been put to them again; mesh_groups says what each is doing.`,
		);
		if (m.ctx?.hasUI) {
			m.ctx.ui.notify(
				`Mesh: no answer yet from ${[...new Set(stuck.flatMap((one) => one.waitingOn))].join(", ")}`,
				"warning",
			);
		}
		m.pi.sendMessage(
			{
				customType: NOTED,
				content: lines.join("\n\n"),
				display: true,
				details: delivered([], []),
			},
			{ triggerTurn: false },
		);
	};

	/**
	 * Who is still there, read again: it changes without a message saying
	 * so, and a quest's address left to a peer that ended is taken back.
	 * Every peer is listed once, off the thread, for each step that asks.
	 */
	const lookAround = async () => {
		const everyone = await m.presences.listed();
		await countLive(everyone);
		// Neither step, nor this session's inboxes, holds back another
		// peer's wake: a full disk fails the one each minute.
		apart(() => m.peer?.refresh(everyone));
		apart(identity);
		await m.steering?.look().catch(takenAtNextLook);
		// A parked peer told to close or carry is started again to do it.
		if (m.paths.steer !== undefined) {
			await wakeSteered(everyone, m.paths.steer, isParked, askWake);
		}
	};

	/**
	 * Wakes the parked peers here that a message carried in gives a turn.
	 * It takes a peer running here to hear it land. On a machine whose
	 * every session is parked nothing here hears it: that waits on the
	 * node writing the wake as it carries the message in (KP0L6A's
	 * mycelium change), and until then on the machine's next start.
	 */
	const wakeForElsewhere = (message: Message) => {
		try {
			wakeForCarriedIn(
				message,
				// Kept parses, a stat a file (a host's mirror on a host).
				m.presences.all(),
				(id) => m.transport.read(id),
				isParked,
				askWakeOnce,
				(addresses) => m.transport.lastRead(addresses),
			);
		} catch {
			// Every running peer judges this arrival, so another may wake for
			// it; unwoken, it is read at the parked peer's next start.
		}
	};

	/** A step of the minute's look, run whatever the steps before it did. */
	const apart = (step: () => void) => {
		try {
			step();
		} catch {
			// Tried again at the next minute's look.
		}
	};

	/** The look a start's catch-up passed over, if it passed one over. */
	const lookIfPassedOver = () => {
		if (!lookPassedOver) return;
		lookPassedOver = false;
		// After the look that passed it over: joined while that one still
		// runs, it would end with it, owing what it was passed over for
		// until the next minute's look.
		void lastLook.then(lookAgain);
	};

	/** Messages the watcher never reported, taken as it would have. */
	const lookForMissed = async () => {
		// Not while the start catches up: until it has listed, what it marks
		// seen isn't, and a look would read those on the thread and route
		// what is the catch-up's own as new, with a turn. It looks once the
		// catch-up is done instead.
		if (!m.startCaughtUp) {
			lookPassedOver = true;
			return;
		}
		// Listed off the thread: the folder holds a week of messages, and
		// listing it at once held the thread a key waits on.
		const missed = (await m.transport.listIds())
			.filter((id) => !m.seen.has(id))
			.map(take)
			.filter((one): one is Message => one !== undefined);
		if (missed.length > 0) void route(missed);
	};

	// A tick that comes while the last look still reads is passed over:
	// on a stalled disk, looks stacking up would only queue more reads.
	const looking = singleFlight<string, void>();
	// Settled once the newest look has ended, however it ended.
	let lastLook: Promise<void> = Promise.resolve();

	/** What a minute changed that nothing said, looked at again. */
	const lookAgain = () => {
		if (!m.peer) return;
		chase();
		if (m.left.size > 0) void reconsider();
		lastLook = looking("again", async () => {
			// Both end before the next tick may look: one failing leaves the
			// other to finish rather than run beside its next.
			await Promise.allSettled([lookAround(), lookForMissed()]);
		}).catch(() => {
			// Unread now: the next tick looks again.
		});
	};

	return {
		countLive,
		awaited,
		askFlows,
		identity,
		judge,
		routing,
		route,
		replacedBy,
		take,
		catchUp,
		letGo,
		lookIfPassedOver,
		reconsider,
		addressesOf,
		chase,
		lookAgain,
	};
}

/** What createHearing gives the modules after it. */
export type Hearing = ReturnType<typeof createHearing>;
