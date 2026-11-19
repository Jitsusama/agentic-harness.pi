/**
 * The service's control backend: the order a conversation is held, started,
 * ended and resumed in, over the engine's live ownership and the durable
 * roster. A conversation is held durably before the engine registers it and
 * dropped only after a deliberate close or release commits, so a crash at any
 * step leaves it held for the next start rather than lost.
 */
import type { RosterEntry } from "../../lib/core/session/roster.ts";
import { sessionAddress } from "../../lib/mesh/address.ts";
import { attachWaits } from "./attach-waits.ts";
import type { ControlBackend } from "./dispatch.ts";
import type { ControlRequest, SessionIdentity } from "./protocol.ts";
import type { AdmitAnother } from "./rollout.ts";
import type { HostRoster } from "./roster.ts";

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
	start(prepared: Prepared, request: OpenRequest | AdoptRequest): Promise<void>;
	discard(prepared: Prepared): Promise<void>;
	/**
	 * `woken` when a person or a message asked for it from a park, rather
	 * than the host resuming what it held as it starts. `mark` hears each
	 * phase of the start as it ends, so a slow one can be told apart.
	 */
	resume(
		entry: RosterEntry,
		woken?: boolean,
		mark?: (phase: ResumePhase) => void,
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
	 * Whether a conversation the host holds has lost its session file, so
	 * nothing could ever resume it: a start drops it rather than keep it.
	 */
	lost?(entry: RosterEntry): boolean;
	/**
	 * A start is about to resume `held`, what the host holds: carry on none
	 * of the runs a restart cut off until resumed says it has resumed them
	 * all, so they go a few at a time in the whole start's order: the
	 * order they asked in, which is roughly the order held, since a few
	 * resume at once.
	 */
	resuming?(held: readonly string[]): void;
	/** The start has resumed everything it holds; the runs it cut off may go. */
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
	close(id: string, why?: string): Promise<void>;
}

// One conversation's end as the journal says it: its mesh address, its
// id, and why, the caller or viewer that asked among it.
function endedLine(sessionId: string, why: string): string {
	return `${sessionAddress(sessionId)} (${sessionId}) ended: ${why}`;
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
	/** How long an attach waits before the journal says on what: attach-waits.ts's ATTACH_SLOW_MS. */
	attachSlowMs?: number;
}): HostBackend {
	const { host, roster, engine } = options;
	const now = options.now ?? (() => new Date());
	// Begins still in progress, so two opens at once on an empty host can't
	// both count themselves first.
	let beginning = 0;
	// Each conversation's wakes and ends, one at a time, so a close never
	// lands between a wake's look at the roster and its resume.
	const turns = new Map<string, Promise<unknown>>();
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
			if (holds !== undefined) return;
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
				await engine.resume(entry, true);
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
			if (host.holds(sessionId) === undefined && rostered(sessionId)) {
				waits.next("its wake");
				await wake(sessionId);
			}
			const shown = live(sessionId);
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
	// person can see it and close it.
	function stranded(): SessionIdentity[] {
		return roster
			.entries()
			.filter((held) => host.holds(held.sessionId) === undefined)
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

	async function begin(
		request: OpenRequest | AdoptRequest,
	): Promise<SessionIdentity> {
		const another = roster.entries().length + beginning > 0;
		beginning += 1;
		try {
			if (another) await options.admitAnother?.();
			return await started(request);
		} finally {
			beginning -= 1;
		}
	}

	async function started(
		request: OpenRequest | AdoptRequest,
	): Promise<SessionIdentity> {
		const prepared = await engine.prepare(request);
		let settle = (): void => undefined;
		starts.set(
			prepared.sessionId,
			new Promise<void>((done) => {
				settle = done;
			}),
		);
		try {
			return await startedAs(request, prepared);
		} finally {
			starts.delete(prepared.sessionId);
			settle();
		}
	}

	async function startedAs(
		request: OpenRequest | AdoptRequest,
		prepared: Prepared,
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
			await engine.discard(prepared);
			throw error;
		}
		try {
			await engine.start(prepared, request);
		} catch (error) {
			// Registered and failed: the engine parked it, so it stays held for
			// a person to close. Never registered: nothing owns it, so undo.
			if (host.holds(prepared.sessionId) === undefined) {
				await engine.discard(prepared);
				await roster.drop(prepared.sessionId);
			}
			throw error;
		}
		return live(prepared.sessionId);
	}

	// The reason it closes with names the caller, so the journal line the
	// engine's ended brings says who asked; one not running (parked, or
	// stranded) has no end to bring it, so it is said here.
	function end(
		sessionId: string,
		why: "closed" | "released",
		by: string | undefined,
	) {
		const owed = startOwes(sessionId);
		return inTurn(sessionId, async () => {
			await owed;
			// A park under way holds it while no longer running: once settled,
			// it is closed as a parked one, its viewers told and the end said.
			await engine.parkSettled?.(sessionId);
			const running = host.holds(sessionId) !== undefined;
			if (!running && !rostered(sessionId))
				throw new Error(`Conversation is not hosted: ${sessionId}`);
			const asked = `${why}, asked by ${askedBy(by)}`;
			if (why === "released") engine.handsOn?.(sessionId);
			if (running) await host.close(sessionId, asked);
			await roster.drop(sessionId);
			if (!running) {
				// Said first: the roster has let it go, whatever its screen does.
				options.say?.(endedLine(sessionId, `${asked}, held but not running`));
				await engine.dropped?.(sessionId, asked);
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
		options.say?.(
			`${on ? "Draining for a restart" : "Drain lifted"}, asked by ${askedBy(by)}: ${result.busy} busy, ${result.idle} idle, ${result.parked} parked; heavy runs: ${heavy.length > 0 ? heavy.join("; ") : "none"}`,
		);
		return result;
	}

	return {
		identity: options.identity,
		wake,
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
					return end(request.sessionId, "closed", request.by);
				case "release":
					return end(request.sessionId, "released", request.by);
				case "drain":
					return drain(request.on, request.by);
				case "abort":
					await startOwes(request.sessionId);
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

/**
 * Keep the roster true to what pi did inside a conversation. A conversation
 * that becomes another is held in its place in one write, keeping whether
 * it is attended, its quest and, unless the engine derived a new one, its
 * launch environment; one that ended is dropped. A drop that fails is
 * reported rather than thrown back into pi, whose conversation has already
 * ended; a replacement that fails rejects, so the engine never runs a
 * conversation nothing holds.
 */
export function conversationEvents(options: {
	roster: HostRoster;
	report: (error: unknown) => void;
	/** How a parked conversation is woken: the backend's wake, once it exists. */
	wake?: (sessionId: string) => Promise<void>;
	now?: () => Date;
	/** Writes a line to the host's journal: one for each conversation that ends, and why. */
	say?: (line: string) => void;
}): ConversationEvents {
	const { roster, report } = options;
	const now = options.now ?? (() => new Date());
	const { wake } = options;
	return {
		...(wake ? { wake } : {}),
		async ended(sessionId, why) {
			options.say?.(endedLine(sessionId, why));
			try {
				await roster.drop(sessionId);
			} catch (error) {
				report(error);
			}
		},
		async became(previousId, next) {
			const previous = roster
				.entries()
				.find((held) => held.sessionId === previousId);
			if (!previous) throw new Error(`Conversation is not held: ${previousId}`);
			const launch = next.launch ?? previous.launch;
			await roster.replace(previousId, {
				sessionId: next.sessionId,
				file: next.file,
				cwd: next.cwd,
				attended: previous.attended,
				...(previous.quest ? { quest: previous.quest } : {}),
				since: now().toISOString(),
				...(launch ? { launch } : {}),
			});
		},
	};
}

/**
 * The phases of a conversation's resume, each marked as it ends: the
 * start's own ask for more time, the gate on another one running, the
 * session file read, an earlier host's tools reaped, pi's runtime built,
 * its screen or headless binding, and durable's recovery begun.
 */
export type ResumePhase =
	| "ask"
	| "gate"
	| "log"
	| "reap"
	| "runtime"
	| "screen"
	| "recovery";

/** How a resume a start began ended: built, left parked, or still held unbuilt. */
export type ResumeEnd = "resumed" | "parked" | "unresumed";

/** A held conversation a starting host is about to resume, counted from one. */
export interface Resuming {
	readonly step: "resume";
	readonly number: number;
	readonly of: number;
	readonly sessionId: string;
}

/**
 * The order a start resumes what its roster held as it began: as held,
 * apart from those asked for (`ahead`), which go first, first asked
 * first. Only the start takes from it (`next`), says each it is done
 * with (`settled`), and ends it (`end`).
 */
export interface HeldOrder {
	/** How many the start owes as it begins. */
	readonly total: number;
	/**
	 * Bring it forward if the start still owes it, and settle once the
	 * start has resumed it or left it, failed included; at once for one it
	 * owes nothing, or once the start has ended.
	 */
	ahead(sessionId: string): Promise<void>;
	/** The next the start resumes, or none once it owes no more. */
	next(): RosterEntry | undefined;
	/** The start is done with it, resumed or not. */
	settled(sessionId: string): void;
	/** The start is over: whoever still waits is answered. */
	end(): void;
}

/** The order a start resumes what `roster` holds now. */
export function heldOrder(roster: HostRoster): HeldOrder {
	const rest = [...roster.entries()];
	const asked: RosterEntry[] = [];
	const owed = new Set(rest.map(({ sessionId }) => sessionId));
	const waiting = new Map<
		string,
		{ done: Promise<void>; settle: () => void }
	>();

	function settled(sessionId: string): void {
		owed.delete(sessionId);
		waiting.get(sessionId)?.settle();
		waiting.delete(sessionId);
	}

	return {
		total: rest.length,
		ahead(sessionId) {
			if (!owed.has(sessionId)) return Promise.resolve();
			const queued = rest.findIndex((held) => held.sessionId === sessionId);
			if (queued >= 0) asked.push(...rest.splice(queued, 1));
			let wait = waiting.get(sessionId);
			if (!wait) {
				let settle = (): void => undefined;
				const done = new Promise<void>((resolve) => {
					settle = resolve;
				});
				wait = { done, settle };
				waiting.set(sessionId, wait);
			}
			return wait.done;
		},
		next: () => asked.shift() ?? rest.shift(),
		settled,
		end() {
			for (const sessionId of [...owed]) settled(sessionId);
			rest.length = 0;
			asked.length = 0;
		},
	};
}

/**
 * How many conversations a start resumes together once one has resumed
 * alone. On 18 November a start of 81, one at a time, took 479 s, each
 * resume mostly waiting, its host's thread busy 43% of the time; more
 * than a few at once would only queue on that thread.
 */
export const RESUME_AT_ONCE = 4;

/**
 * Resume every held conversation at start, in the order they were held,
 * or as `order` brings one forward: alone until one has resumed, then
 * RESUME_AT_ONCE at a time, each taking the next as it ends. One that parked before the start and
 * rests parked (`restsParked`), which builds nothing, so passes no gate
 * and counts as parked rather than resumed. One whose session file is
 * gone (`lost`) can never resume, so it is dropped from the roster and
 * named in `dropped`: on 17 November a start kept 32 such holds that only
 * a person could have closed. Any other that can't resume stays held,
 * since only a deliberate close or release may drop a hold, and is
 * reported for a person to close or repair. With `admitAnother`, each
 * after the first that resumed must pass it, so the same one runs alone after every
 * restart and a refused one is parked with the open path's reason.
 * `starting` hears each one before it begins, so whoever waits on the
 * start knows it still moves; if it throws, that conversation stays held
 * and is reported like one that couldn't resume, and the rest go on.
 * `mark` hears each phase as it ends and `finished` each one's end,
 * resumed, parked or failed with why, under its own step, since several
 * run at once. A throw from `mark` at the phases this marks itself (ask
 * and gate) fails that conversation's resume; the engine's build hears it
 * too, so it must not throw there. One from `finished` fails the start,
 * once no resume is still building.
 * The runs a restart cut off wait until the last has resumed
 * (`resuming`, then `resumed`, also when one throws), so a few go at a
 * time in the whole start's order rather than racing the resumes; that
 * order is the one they asked in, roughly the order held, since a few
 * resume at once.
 * One no longer held when its turn comes, closed while the start ran,
 * is passed over. Once `halted` says so, as a stop does, none begins:
 * those under way end, and the rest stay held for the next start.
 * `settled` hears each one's id as its turn ends, however it ended.
 */
export async function resumeHeld(options: {
	roster: HostRoster;
	engine: ConversationEngine;
	admitAnother?: AdmitAnother;
	halted?: () => boolean;
	settled?: (sessionId: string) => void;
	starting?: (step: Resuming) => Promise<void>;
	mark?: (step: Resuming, phase: ResumePhase) => void;
	finished?: (step: Resuming, end: ResumeEnd, reason?: unknown) => void;
	order?: HeldOrder;
}): Promise<HeldResumed> {
	const resumed: string[] = [];
	const parked: string[] = [];
	const dropped: string[] = [];
	const unresumed: Unresumed[] = [];
	const order = options.order ?? heldOrder(options.roster);
	let number = 0;

	async function resumeOne(entry: RosterEntry): Promise<void> {
		number += 1;
		const { sessionId } = entry;
		const step: Resuming = {
			step: "resume",
			number,
			of: order.total,
			sessionId,
		};
		const mark = (phase: ResumePhase) => options.mark?.(step, phase);
		let began = false;
		let end: ResumeEnd = "unresumed";
		let failure: unknown;
		try {
			if (
				!options.roster.entries().some((held) => held.sessionId === sessionId)
			)
				return;
			// Dropped before it is said as resuming, since nothing resumes.
			if (options.engine.lost?.(entry)) {
				await options.roster.drop(sessionId);
				dropped.push(sessionId);
				return;
			}
			began = true;
			await options.starting?.(step);
			mark("ask");
			if (options.engine.restsParked?.(entry)) {
				parked.push(sessionId);
				end = "parked";
				return;
			}
			if (resumed.length > 0) await options.admitAnother?.();
			mark("gate");
			await options.engine.resume(entry, false, mark);
			resumed.push(sessionId);
			end = "resumed";
		} catch (reason) {
			unresumed.push({ sessionId, reason });
			failure = reason;
		} finally {
			order.settled(sessionId);
			options.settled?.(sessionId);
			if (began) options.finished?.(step, end, failure);
		}
	}

	const halted = () => options.halted?.() ?? false;
	/** The next the order owes, or none once halted. */
	const next = () => (halted() ? undefined : order.next());

	/** Take the next as each ends, until the order owes no more. */
	async function resumeRest(): Promise<void> {
		for (let entry = next(); entry; entry = next()) await resumeOne(entry);
	}

	options.engine.resuming?.(
		options.roster.entries().map((entry) => entry.sessionId),
	);
	try {
		// Alone until one resumes, so the rollout gate's first runs by itself.
		while (resumed.length === 0) {
			const entry = next();
			if (!entry) break;
			await resumeOne(entry);
		}
		// Every worker ends before the start does, so one that throws (a
		// listener's fault, since each resume's own is caught) leaves none
		// still building as the runs a restart cut off are let go.
		const rest = await Promise.allSettled(
			Array.from({ length: RESUME_AT_ONCE }, () => resumeRest()),
		);
		const failed = rest.find(
			(worker): worker is PromiseRejectedResult => worker.status === "rejected",
		);
		if (failed) throw failed.reason;
	} finally {
		order.end();
		options.engine.resumed?.();
	}
	return { resumed, parked, dropped, unresumed };
}

/** What a start did with each conversation the host held. */
export interface HeldResumed {
	/** Built and running again, in the order they finished. */
	readonly resumed: string[];
	/** Left parked as their last process parked them, building nothing. */
	readonly parked: string[];
	/** Dropped from the roster, since their session files are gone. */
	readonly dropped: string[];
	/** Still held but not running, each with why it would not resume. */
	readonly unresumed: Unresumed[];
}
