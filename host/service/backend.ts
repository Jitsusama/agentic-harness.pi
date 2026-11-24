/**
 * The service's control backend: the order a conversation is held, started,
 * ended and resumed in, over the engine's live ownership and the durable
 * roster. A conversation is held durably before the engine registers it and
 * dropped only after a deliberate close or release commits, so a crash at any
 * step leaves it held for the next start rather than lost.
 */
import { resolve } from "node:path";
import type { RosterEntry } from "../../lib/core/session/roster.ts";
import { sessionAddress } from "../../lib/mesh/address.ts";
import type { HostChanges } from "../engine/session-host.ts";
import { attachWaits } from "./attach-waits.ts";
import { CHILD_SAID_UNSETTLED, leftRunning } from "./child-requests.ts";
import { endedLine } from "./conversation-events.ts";
import {
	type ControlBackend,
	type ControlReply,
	hostRefusal,
} from "./dispatch.ts";
import type { ControlRequest, SessionIdentity } from "./protocol.ts";
import { type Outcome, REPEAT_WINDOW_MS, repeats } from "./repeats.ts";
import type { HeldOrder } from "./resume-held.ts";
import type { AdmitAnother } from "./rollout.ts";
import type { HostRoster } from "./roster.ts";
import { firstLine, onOneLine, type PhaseEnd, startLine } from "./status.ts";
import {
	OPEN_UNSETTLED,
	unsettledMessage,
	unsettledSession,
} from "./unsettled-open.ts";

/** An open request as the wire validated it. */
export type OpenRequest = Extract<ControlRequest, { op: "open" }>;
/** An adopt request as the wire validated it. */
export type AdoptRequest = Extract<ControlRequest, { op: "adopt" }>;

/** A conversation the engine named and created but has not registered. */
export interface Prepared {
	readonly sessionId: string;
	readonly file: string;
	readonly cwd: string;
	/**
	 * The environment the engine derived for the conversation from its
	 * request, held with it so a resume replays it exactly.
	 */
	readonly launch?: Readonly<Record<string, string>>;
}

/**
 * What the engine does for the service. Prepare names the pi id and file
 * without registering; start registers, loads extensions and, for open with
 * first words, resolves once the first durable submit commits; discard
 * undoes only what prepare created; resume re-registers a held conversation,
 * with the launch environment it was held with, and rejects with the reason
 * it can't; abort stops the current run and keeps ownership. watch, called
 * once before anything resumes or opens, hands the engine what to tell the
 * service when a conversation changes inside pi rather than over the wire.
 */
export interface ConversationEngine {
	prepare(request: OpenRequest | AdoptRequest): Promise<Prepared>;
	/** `mark` hears each phase of the start as it ends, as a resume's does. */
	start(
		prepared: Prepared,
		request: OpenRequest | AdoptRequest,
		mark?: (phase: StartPhase) => void,
	): Promise<void>;
	discard(prepared: Prepared): Promise<void>;
	/**
	 * `woken` when a person or a message asked for it from a park, rather
	 * than the host resuming what it held as it starts. `mark` hears each
	 * phase of the start as it ends, so a slow one can be told apart.
	 */
	resume(
		entry: RosterEntry,
		woken?: boolean,
		mark?: (phase: StartPhase) => void,
	): Promise<void>;
	/**
	 * A host starting asks first whether a conversation it holds parked
	 * before then, its park marker standing: if so the engine leaves it
	 * parked, watching for its wake, and answers true, building nothing
	 * until it is asked for; otherwise it does nothing and the start
	 * resumes it.
	 */
	restsParked?(entry: RosterEntry): boolean;
	/**
	 * A conversation the host still holds, whose child was given up before
	 * it ran there, rests as parked: its park marker is written naming the
	 * host's wake file, where none from this boot does, and it is taken on
	 * as `restsParked` takes one, so a message sent to it wakes it, and
	 * nothing is answered. Answers why, doing nothing, while the host runs
	 * it or another holder's marker stands. Never asked at a start, which
	 * still resumes one that never parked.
	 */
	restGivenUp?(entry: RosterEntry): string | undefined;
	/**
	 * Whether a conversation the host holds has lost its session file, so
	 * nothing could ever resume it: a start drops it rather than keep it.
	 */
	lost?(entry: RosterEntry): boolean;
	/**
	 * A start is about to resume `held`, what the host holds: carry on none
	 * of the runs a restart cut off but those Joel waits on until resumed
	 * says it has resumed them all, so they go a few at a time in the whole
	 * start's order: his first, then the order they asked in, which is
	 * roughly the order held, since a few resume at once.
	 */
	resuming?(held: readonly string[]): void;
	/** The start has resumed everything it holds; every run it cut off may go. */
	resumed?(): void;
	abort(sessionId: string): Promise<void>;
	/**
	 * How much background work one conversation holds: commands, fleets
	 * and rounds still running, and results not yet said, which a host
	 * restart would end or lose.
	 */
	backgroundOf(sessionId: string): number;
	/**
	 * Whether any stop can keep the bash calls its conversations carry
	 * alive for the next host, so every stop carries them, not only a
	 * restart. An engine that leaves it out carries them only through its
	 * own restart.
	 */
	carries?(): boolean;
	/**
	 * As a stop that carries ends the host, once every conversation has
	 * parked: keep the bash calls they carried alive through the stop for
	 * the next host to take up.
	 */
	keepCarried?(): Promise<void>;
	/**
	 * Start or lift a drain for a restart: while it lasts each
	 * conversation parks as soon as its park rule holds, idle time aside,
	 * a wake through its file or a steer waits for the lift (or for its
	 * restart to pass the settle ceiling, `letWakesThrough`), and a heavy
	 * run holds the host's restart. Answers with the heavy runs going
	 * now, a line each. An engine that can't drain leaves it out.
	 */
	drain?(on: boolean): readonly string[];
	/** Whether a drain stands now, whoever asked for it. */
	drains?(): boolean;
	/**
	 * Once a park of the conversation under way has settled, at once when
	 * none is: until then it is still held, though it is no longer running.
	 */
	parkSettled?(sessionId: string): Promise<void>;
	watch?(events: ConversationEvents): void;
	/**
	 * A held conversation that wasn't running, such as a parked one, was
	 * closed or released: let go of what is kept for its wake, its screen's
	 * terminal and viewers among it, telling them `why` as a close does.
	 */
	dropped?(sessionId: string, why: string): Promise<void>;
	/**
	 * The conversation is about to be released to another holder, such as
	 * plain pi or another machine: its close, running or parked, keeps what
	 * its ended calls left running, as a stop does, where a close for good
	 * ends it.
	 */
	handsOn?(sessionId: string): void;
	/**
	 * A conversation this host held parked now runs in a child of its own:
	 * stop watching for its wake, warming its cache and holding its log,
	 * since the child does each now.
	 */
	movedOut?(sessionId: string): void;
}

/**
 * The conversations that run in children of their own (children.ts), as
 * the backend starts and wakes them; the host runs the rest itself.
 */
export interface BackendChildren {
	/** Whether this conversation goes to a child as it next wakes. */
	moves(sessionId: string): boolean;
	/** Whether a conversation opened or adopted now starts in a child. */
	opens(): boolean;
	/** The conversation as the child running it lists it; nothing when none does. */
	running(sessionId: string): SessionIdentity | undefined;
	/**
	 * Run a held conversation in a child, `woken` when its park's wake
	 * asked; `bounded` gives up on a child that hasn't listened within
	 * the listen time, starved or not, for a caller that can't wait.
	 */
	resume(
		entry: RosterEntry,
		woken: boolean,
		bounded?: boolean,
	): Promise<SessionIdentity>;
	/**
	 * Start a conversation in a child, settling with the child's answer,
	 * within a begin's time of `taken`, when the host took the request.
	 */
	begin(
		request: OpenRequest | AdoptRequest,
		taken: number,
	): Promise<ControlReply>;
	/**
	 * Ask the child running a conversation a request that reached the host
	 * before its route did, answering as the child does or with its refusal.
	 */
	ask(sessionId: string, request: ControlRequest): Promise<unknown>;
	/**
	 * Settles once no child runs this conversation: every one that ran it
	 * has gone and its own slot is free, or runs what it became once the
	 * roster's write of that has landed (one that fails is reported and
	 * let go). Fails
	 * while one still runs it, or once the host stops watching, so the host never runs it beside one.
	 */
	left(sessionId: string): Promise<void>;
	/**
	 * Give up a resume of this conversation under way in a child that
	 * doesn't have it yet, stopping that child, so an end asked behind a
	 * wake waiting on a starved one answers at once rather than when the
	 * child does or its supervisor stops waiting. Nothing when none is.
	 */
	giveUp?(sessionId: string): void;
}

/**
 * What the engine tells the service about a conversation pi changed
 * itself. ended: the conversation itself ended (pi's quit, an extension's
 * shutdown, a replacement), after its close committed; never for the
 * host stopping, which parks conversations and keeps them held. became:
 * a held conversation is becoming another under a new id (pi's new, fork
 * or resume), awaited before the engine registers the new id, which it
 * must not register when this rejects. wake: a conversation the engine
 * parked is asked for (its wake file was written, or a viewer typed to
 * it): the service wakes it as an attach would, or says why not.
 */
export interface ConversationEvents {
	ended(sessionId: string, why: string): Promise<void>;
	became(previousId: string, next: Prepared): Promise<void>;
	wake?(sessionId: string): Promise<void>;
}

/** The engine's live ownership, as SessionHost keeps it. */
export interface LiveHost {
	list(): readonly {
		readonly id: string;
		readonly file: string;
		readonly cwd: string;
		readonly state: SessionIdentity["state"];
		readonly since: string;
	}[];
	holds(id: string): SessionIdentity["state"] | undefined;
	close(id: string, why?: string, handedOn?: boolean): Promise<void>;
}

// Who sent a control request, as it named itself; a name is only a
// caller's word, so it is kept to one plain line.
function askedBy(by: string | undefined): string {
	return by === undefined
		? "a control request that didn't say who sent it"
		: `${by.replace(/\p{Cc}/gu, " ")} over the control socket`;
}

/** A held conversation the engine could not resume, and why. */
export interface Unresumed {
	readonly sessionId: string;
	readonly reason: unknown;
}

/** The control backend, and the one thing it does for the engine: wake. */
export interface HostBackend extends ControlBackend {
	/**
	 * Wake a parked conversation, held but not running, as its resume
	 * would: in the same turn as a close of it, so one closed while it
	 * slept stays closed, and through `admitAnother` beside any other
	 * conversation. One running already, or no longer held, is left alone;
	 * one whose build fails stays held, parked, as a failed open does, and
	 * a wake of it after says so. One still parking is woken once settled.
	 */
	wake(sessionId: string): Promise<void>;
	/**
	 * Once every wake and end under way has finished, so a stop parks what
	 * they leave rather than racing a resume into a host it disposes.
	 */
	settled(): Promise<void>;
	/**
	 * A held conversation became another (pi's new, fork or resume), so a
	 * repeat of the open that made it answers with the one it became.
	 */
	became(previousId: string, nextId: string): void;
}

/**
 * Answer every control operation in the order that keeps holds durable.
 * With `admitAnother`, an open, adopt or wake while the host already
 * holds a conversation, or is starting one, must pass it first (the
 * rollout gate, rollout.ts); a refusal prepares and holds nothing.
 */
export function hostBackend(options: {
	identity: ControlBackend["identity"];
	host: LiveHost;
	roster: HostRoster;
	engine: ConversationEngine;
	admitAnother?: AdmitAnother;
	now?: () => Date;
	/** Writes a line to the host's journal, as each close of one held but not running. */
	say?: (line: string) => void;
	/**
	 * The start's order, when the host listens while it resumes: a window,
	 * wake, end or abort of one the start still owes brings it forward and
	 * waits for the start's own resume, so none resumes twice.
	 */
	held?: Pick<HeldOrder, "ahead">;
	/**
	 * Hears a close or release of one held but not running, which no
	 * conversation's end brings, as a child whose one conversation parked
	 * away must, to end as closed or released rather than parked.
	 */
	changes?: Pick<HostChanges, "left">;
	/** How long an attach waits before the journal says on what: attach-waits.ts's ATTACH_SLOW_MS. */
	attachSlowMs?: number;
	/** Children to run conversations in; without, the host runs every one. */
	children?: BackendChildren;
}): HostBackend {
	const { host, roster, engine, children } = options;
	const now = options.now ?? (() => new Date());
	// Begins still in progress, so two opens at once on an empty host can't
	// both count themselves first.
	let beginning = 0;
	// Each open and adopt by its request id, so one asked again after its
	// answer was lost gets the first's conversation, not a twin: CWUEGJ's
	// retry of a spawn that timed out while it loaded made one of ZH3VLR
	// (IKQ63G, 20 November).
	// An answer stands while its conversation is still held, and a start
	// that failed after registering stands while that one is (F2, F3).
	// The journal says each repeat, since a spawn that reports success
	// while nothing new runs is otherwise unexplained there (F19).
	const asked = repeats(
		Date.now,
		REPEAT_WINDOW_MS,
		stillStands,
		(id, underWay) =>
			options.say?.(
				underWay
					? `Request ${id} was asked again while its start was under way; it joins that start`
					: `Request ${id} was asked again; it gets the answer its first ask got`,
			),
	);
	// Each failed start's error, by the conversation it left held.
	const leftHeld = new WeakMap<object, string>();
	// Each conversation that became another, by the one it became, so a
	// repeat of the open that made it answers with the one now running;
	// kept as long as a repeat is.
	const became = new Map<string, { next: string; at: number }>();
	// Each conversation's wakes and ends, one at a time, so a close never
	// lands between a wake's look at the roster and its resume.
	const turns = new Map<string, Promise<unknown>>();
	// Each conversation's ends asked but not yet in their turn, counted, so
	// a wake ahead of one starts no child it would wait out (F24).
	const ending = new Map<string, number>();
	// Each open or adopt from its roster hold until its start has settled.
	// The engine lists a conversation as it registers it, seconds before
	// its screen exists, and a join in place takes a listed conversation as
	// open: an attach inside those seconds found no screen, and its window
	// closed (QCXZEB's move in place, 11 November).
	const starts = new Map<string, Promise<void>>();

	function inTurn<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
		const before = turns.get(sessionId) ?? Promise.resolve();
		const turn = before.catch(() => undefined).then(work);
		const kept = turn.catch(() => undefined);
		turns.set(sessionId, kept);
		void kept.then(() => {
			if (turns.get(sessionId) === kept) turns.delete(sessionId);
		});
		return turn;
	}

	// Asked as the call comes, not in its turn, so the start resumes those
	// asked for in the order they were.
	function startOwes(sessionId: string): Promise<void> {
		return options.held?.ahead(sessionId) ?? Promise.resolve();
	}

	function wake(sessionId: string): Promise<void> {
		const owed = startOwes(sessionId);
		return inTurn(sessionId, async () => {
			await owed;
			await engine.parkSettled?.(sessionId);
			const holds = host.holds(sessionId);
			// Held and not running: its last start failed, or a park's stop did
			// (parking.ts leaves it held as a failed close does), and only a close
			// lets it go.
			if (holds === "parked")
				throw new Error(
					`Conversation ${sessionId} is held but not running, since its last start or park failed; close it and open it again`,
				);
			if (holds !== undefined || children?.running(sessionId)) return;
			// A child that just failed may still be writing its file, whichever
			// process runs the conversation next.
			await children?.left(sessionId);
			const entry = roster
				.entries()
				.find((held) => held.sessionId === sessionId);
			if (!entry) return;
			const another =
				roster.entries().some((held) => held.sessionId !== sessionId) ||
				beginning > 0;
			beginning += 1;
			try {
				if (another) await options.admitAnother?.("wake");
				if (children?.moves(sessionId)) {
					// An end asked since takes it, held and not running, as it
					// would after a starved child; none is started to be given up.
					if (ending.has(sessionId)) return;
					await children.resume(entry, true);
					// One whose child already ended was rested again as it ended,
					// so the host keeps watching its wake.
					if (children.running(sessionId)) engine.movedOut?.(sessionId);
				} else await engine.resume(entry, true);
			} finally {
				beginning -= 1;
			}
		});
	}

	// A window's attach: answered once its conversation can be shown, the
	// journal saying each wait that holds it past the bound, and then when
	// it is answered. A wait that passes at once says nothing.
	async function attachment(sessionId: string): Promise<SessionIdentity> {
		const waits = attachWaits(
			`${sessionAddress(sessionId)} (${sessionId})`,
			options.say,
			options.attachSlowMs,
		);
		try {
			waits.next("the host's start to resume it");
			await startOwes(sessionId);
			waits.next("its open to finish");
			await starts.get(sessionId);
			waits.next("its park to settle");
			await engine.parkSettled?.(sessionId);
			const inHost = host.holds(sessionId) !== undefined;
			if (!inHost && !children?.running(sessionId) && rostered(sessionId)) {
				waits.next("its wake");
				await wake(sessionId);
			}
			const shown = children?.running(sessionId) ?? live(sessionId);
			waits.answered();
			return shown;
		} catch (refusal) {
			waits.refused(refusal);
			throw refusal;
		}
	}

	function live(sessionId: string): SessionIdentity {
		const found = host.list().find((held) => held.id === sessionId);
		if (!found) throw new Error(`Conversation is not hosted: ${sessionId}`);
		const { id, file, cwd, state, since } = found;
		// A turn ended with its background work still running is busy to
		// anyone outside, who would end that work by restarting the host;
		// since still says when its turn last changed.
		const working =
			state === "idle" && engine.backgroundOf(id) > 0 ? "busy" : state;
		return { sessionId: id, file, cwd, state: working, since };
	}

	// Held but not running, as after a failed resume: listed parked, so a
	// person can see it and close it. One a child runs is the child's to list.
	function stranded(): SessionIdentity[] {
		return roster
			.entries()
			.filter(
				(held) =>
					host.holds(held.sessionId) === undefined &&
					!children?.running(held.sessionId),
			)
			.map(({ sessionId, file, cwd, since }) => ({
				sessionId,
				file,
				cwd,
				state: "parked",
				since,
			}));
	}

	function rostered(sessionId: string): boolean {
		return roster.entries().some((held) => held.sessionId === sessionId);
	}

	// The conversation `sessionId` is now, after each new, fork or resume
	// that made it another; a loop, which no replace makes, ends the walk.
	function nowCalled(sessionId: string): string {
		let current = sessionId;
		for (let step = 0; step <= became.size; step += 1) {
			const next = became.get(current)?.next;
			if (next === undefined) return current;
			current = next;
		}
		return current;
	}

	function stands(sessionId: string): boolean {
		const current = nowCalled(sessionId);
		return rostered(current) || children?.running(current) !== undefined;
	}

	function stillStands(outcome: Outcome): boolean {
		if (!outcome.ok) {
			const error = outcome.error;
			const held =
				typeof error === "object" && error !== null
					? leftHeld.get(error)
					: undefined;
			return held !== undefined && stands(held);
		}
		const opened = namedIn(outcome.value);
		return opened === undefined || stands(opened);
	}

	// A repeat's answer was taken as its first settled; what it opened may
	// have parked, stranded or become another since, so the answer says
	// the conversation as it is now (F27, F39).
	function asItIsNow(answer: unknown): unknown {
		const opened = namedIn(answer);
		if (opened === undefined) return answer;
		const current = nowCalled(opened);
		if (host.holds(current) !== undefined) return live(current);
		return (
			children?.running(current) ??
			stranded().find((held) => held.sessionId === current) ??
			answer
		);
	}

	async function begin(request: OpenRequest | AdoptRequest): Promise<unknown> {
		try {
			return asItIsNow(await asked.answer(request, () => beginOnce(request)));
		} catch (error) {
			if (error instanceof Error) throw refusedAsItIsNow(error);
			throw error;
		}
	}

	// A repeat's unsettled refusal was taken as its first settled; the
	// conversation it names may have become another since, so it names the
	// one running now, which is what the caller attaches to.
	function refusedAsItIsNow(error: Error): Error {
		const held = leftHeld.get(error);
		if (held === undefined) return error;
		const said = { code: OPEN_UNSETTLED, message: error.message };
		if (unsettledSession(said) !== held) return error;
		const current = nowCalled(held);
		if (current === held) return error;
		const refusal = hostRefusal(OPEN_UNSETTLED, unsettledMessage(current));
		leftHeld.set(refusal, current);
		return refusal;
	}

	async function beginOnce(
		request: OpenRequest | AdoptRequest,
	): Promise<unknown> {
		// A begin's time runs from here, so the gate's census below comes
		// out of it: the caller's wait began when it asked (BEGINS_WITHIN_MS).
		const taken = Date.now();
		const another = roster.entries().length + beginning > 0;
		beginning += 1;
		try {
			if (another) await options.admitAnother?.();
			heldElsewhere(request);
			if (children?.opens()) return await inChild(children, request, taken);
			return await started(request);
		} finally {
			beginning -= 1;
		}
	}

	// The engine refuses an adopt of a file it holds, but only as an
	// error the requester never reads, and a child holds nothing yet; so
	// the host refuses one its roster holds, wherever it would run, in
	// words the requester can act on, rather than start a second pi on
	// one file.
	function heldElsewhere(request: OpenRequest | AdoptRequest): void {
		if (request.op !== "adopt") return;
		const file = resolve(request.sessionFile);
		const holder = roster.entries().find((held) => resolve(held.file) === file);
		// Said to the requester, who can then attach to the one held.
		if (holder)
			throw hostRefusal(
				"already_held",
				`Conversation already held: ${holder.sessionId}`,
			);
	}

	// The child answers as a host would, so its answer is the caller's.
	async function inChild(
		moved: BackendChildren,
		request: OpenRequest | AdoptRequest,
		taken: number,
	): Promise<unknown> {
		const reply = await moved.begin(request, taken);
		if (reply.ok) return reply.result;
		const running = leftRunning(reply);
		// Only the host says a child runs a conversation all the same, since
		// its caller attaches to what that names; one a child said of itself,
		// which the host stopped, is a plain failure to open, in the host's
		// words: the child's would send its caller to attach to a
		// conversation that was stopped, or to one of the child's choosing.
		const saidOfItself =
			running === undefined && reply.error.code === OPEN_UNSETTLED;
		const refusal = saidOfItself
			? hostRefusal("operation_failed", CHILD_SAID_UNSETTLED)
			: hostRefusal(reply.error.code, reply.error.message);
		// The child runs a conversation all the same, so its repeat is told
		// the same, not given a second beside it (F24).
		if (running !== undefined) leftHeld.set(refusal, running);
		throw refusal;
	}

	// Each open and adopt says how long it took and where, as a resume
	// does: a fresh conversation took 17 s to take its first words on 23
	// November, and nothing said which part of its start took them.
	async function started(
		request: OpenRequest | AdoptRequest,
	): Promise<SessionIdentity> {
		const began = Date.now();
		const phases: PhaseEnd[] = [];
		const mark = (phase: StartPhase) => {
			phases.push({ phase, at: Date.now() });
		};
		let sessionId: string | undefined;
		let identity: SessionIdentity;
		try {
			identity = await startedTimed(request, mark, (id) => {
				sessionId = id;
			});
		} catch (error) {
			const line = startLine(sessionId, request, began, phases, Date.now());
			const why = firstLine(error);
			options.say?.(
				`${line}, failing${why ? `: ${why}` : ", with no reason given"}`,
			);
			throw error;
		}
		// Said once it is live, so a say that throws never reads as a failed
		// open of a conversation that runs (F53).
		options.say?.(
			startLine(identity.sessionId, request, began, phases, Date.now()),
		);
		return identity;
	}

	async function startedTimed(
		request: OpenRequest | AdoptRequest,
		mark: (phase: StartPhase) => void,
		named: (sessionId: string) => void,
	): Promise<SessionIdentity> {
		const prepared = await engine.prepare(request);
		named(prepared.sessionId);
		mark("prepare");
		let settle = (): void => undefined;
		starts.set(
			prepared.sessionId,
			new Promise<void>((done) => {
				settle = done;
			}),
		);
		try {
			return await startedAs(request, prepared, mark);
		} finally {
			starts.delete(prepared.sessionId);
			settle();
		}
	}

	async function startedAs(
		request: OpenRequest | AdoptRequest,
		prepared: Prepared,
		mark: (phase: StartPhase) => void,
	): Promise<SessionIdentity> {
		try {
			await roster.hold({
				sessionId: prepared.sessionId,
				file: prepared.file,
				cwd: prepared.cwd,
				attended: request.attended,
				...(request.quest ? { quest: request.quest } : {}),
				since: now().toISOString(),
				...(prepared.launch ? { launch: prepared.launch } : {}),
			});
		} catch (error) {
			await undoing(prepared, "discarding its engine", () =>
				engine.discard(prepared),
			);
			throw error;
		}
		mark("roster");
		try {
			await engine.start(prepared, request, mark);
		} catch (error) {
			// Registered and failed: the engine parked it, so it stays held for
			// a person to close. Never registered: nothing owns it, so undo.
			if (host.holds(prepared.sessionId) === undefined) {
				// Each on its own, so a discard that fails still drops its hold.
				await undoing(prepared, "discarding its engine", () =>
					engine.discard(prepared),
				);
				await undoing(prepared, "dropping its hold", () =>
					roster.drop(prepared.sessionId),
				);
			} else if (typeof error === "object" && error !== null) {
				// Its repeat is told the same, not given a second.
				leftHeld.set(error, prepared.sessionId);
			}
			throw error;
		}
		return live(prepared.sessionId);
	}

	// Undoing a failed start that fails too is said, and the start's own
	// failure is still the one its caller and the journal hear (F52). Each
	// undo is named, so the journal says which one failed. An adopted
	// conversation's id comes from a file the requester names, so it is
	// escaped as the start's own line escapes it (F48).
	async function undoing(
		prepared: Prepared,
		step: string,
		undo: () => Promise<void>,
	) {
		try {
			await undo();
		} catch (error) {
			const why = firstLine(error);
			try {
				options.say?.(
					`${onOneLine(prepared.sessionId)}: undoing its failed start failed too, ${step}${why ? `: ${why}` : ", with no reason given"}`,
				);
			} catch {
				// A journal that can't take the line must not skip the next undo;
				// the start's own failure is still thrown to its caller.
			}
		}
	}

	// The reason it closes with names the caller, so the journal line the
	// engine's ended brings says who asked; one not running (parked, or
	// stranded) has no end to bring it, so it is said here.
	function end(request: Extract<ControlRequest, { op: "close" | "release" }>) {
		const { sessionId, by } = request;
		const why = request.op === "close" ? "closed" : "released";
		const owed = startOwes(sessionId);
		// A wake ahead of it in its turn may wait on a starved child for
		// minutes: that resume is given up, so the end comes at once.
		children?.giveUp?.(sessionId);
		ending.set(sessionId, (ending.get(sessionId) ?? 0) + 1);
		return inTurn(sessionId, async () => {
			const left = (ending.get(sessionId) ?? 1) - 1;
			if (left > 0) ending.set(sessionId, left);
			else ending.delete(sessionId);
			await owed;
			// A park under way holds it while no longer running: once settled,
			// it is closed as a parked one, its viewers told and the end said.
			await engine.parkSettled?.(sessionId);
			const running = host.holds(sessionId) !== undefined;
			// Moved into a child while this waited: the child ends it.
			if (!running && children?.running(sessionId))
				return children.ask(sessionId, request);
			if (!running && !rostered(sessionId))
				throw new Error(`Conversation is not hosted: ${sessionId}`);
			const asked = `${why}, asked by ${askedBy(by)}`;
			if (why === "released") engine.handsOn?.(sessionId);
			if (running) await host.close(sessionId, asked, why === "released");
			await roster.drop(sessionId);
			if (!running) {
				// Said first: the roster has let it go, whatever its screen does.
				options.say?.(endedLine(sessionId, `${asked}, held but not running`));
				await engine.dropped?.(sessionId, asked);
				options.changes?.left(why, asked);
			}
			return { sessionId };
		});
	}

	// Said in the journal with who asked, since a drain parks conversations
	// a person may be about to come back to.
	function drain(on: boolean, by: string | undefined) {
		if (!engine.drain) throw new Error("This host can't drain");
		const heavy = engine.drain(on);
		const sessions = [
			...host.list().map((held) => live(held.id)),
			...stranded(),
		];
		const count = (state: SessionIdentity["state"]) =>
			sessions.filter((held) => held.state === state).length;
		const result = {
			draining: on,
			busy: count("busy"),
			idle: count("idle"),
			parked: count("parked"),
			heavy: [...heavy],
		};
		// Children outlive a restart, so a drain neither parks nor counts them.
		const inChildren = roster
			.entries()
			.filter((held) => children?.running(held.sessionId)).length;
		const apart =
			inChildren > 0
				? `; ${inChildren} in processes of their own, which run on`
				: "";
		options.say?.(
			`${on ? "Draining for a restart" : "Drain lifted"}, asked by ${askedBy(by)}: ${result.busy} busy, ${result.idle} idle, ${result.parked} parked${apart}; heavy runs: ${heavy.length > 0 ? heavy.join("; ") : "none"}`,
		);
		return result;
	}

	return {
		identity: options.identity,
		wake,
		became(previousId, nextId) {
			const at = now().getTime();
			for (const [id, one] of became)
				if (at - one.at > REPEAT_WINDOW_MS) became.delete(id);
			became.delete(nextId);
			became.set(previousId, { next: nextId, at });
		},
		async settled() {
			while (turns.size > 0) await Promise.all(turns.values());
		},
		async execute(request) {
			switch (request.op) {
				case "open":
				case "adopt":
					return begin(request);
				case "list":
					return {
						sessions: [
							...host.list().map((held) => live(held.id)),
							...stranded(),
						],
						host: options.identity,
					};
				case "close":
				case "release":
					return end(request);
				case "drain":
					return drain(request.on, request.by);
				case "watch":
					// Only a child host, one conversation to a process, is watched.
					throw hostRefusal("unsupported", "This host has no watch");
				case "abort":
					await startOwes(request.sessionId);
					if (
						host.holds(request.sessionId) === undefined &&
						children?.running(request.sessionId)
					)
						return children.ask(request.sessionId, request);
					live(request.sessionId);
					await engine.abort(request.sessionId);
					return { sessionId: request.sessionId };
				case "attach":
					// A window opened on a conversation still starting views it once
					// its screen exists, or is refused as its failed start is; one
					// opened on a parked conversation is its person asking for it,
					// as soon as a park under way has settled. One the host's start
					// has yet to resume goes next.
					await attachment(request.sessionId);
					return { sessionId: request.sessionId };
			}
		},
	};
}

// The conversation an answer names, or nothing for one naming none.
function namedIn(answer: unknown): string | undefined {
	if (typeof answer !== "object" || answer === null) return undefined;
	if (!("sessionId" in answer) || typeof answer.sessionId !== "string")
		return undefined;
	return answer.sessionId;
}

/**
 * The phases of a conversation's start, each marked as it ends. A resume
 * has the start's own ask for more time, the gate on another one running
 * and the session file read; an open has its conversation prepared and
 * held in the roster. Then both have an earlier host's tools reaped,
 * pi's runtime built (its model runtime, its services with every
 * extension loaded, durable's store opened and pi's session made, then
 * the rest, its extensions' session start among it), its screen or
 * headless binding, durable's recovery begun and, for an open with first
 * words, those words held. A start whose screen asks the person answers
 * at the ask, marked `asked`: what it builds after is not timed, and a
 * failure after it is the engine's to say.
 */
export type StartPhase =
	| "asked"
	| "ask"
	| "gate"
	| "log"
	| "prepare"
	| "roster"
	| "reap"
	| "models"
	| "services"
	| "store"
	| "session"
	| "runtime"
	| "screen"
	| "recovery"
	| "first";
