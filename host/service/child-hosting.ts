/**
 * A host's children, put together: the routes a child's conversation
 * answers at, the supervisor that starts and watches each child, and the
 * policy that says which conversations move. The backend asks it to wake,
 * open and resume in children; the server routes by its routes.
 *
 * A child that ends parked leaves its conversation held and resting, so
 * the host watches its wake again (the engine's restsParked) and a wake
 * starts a child for it anew. No process runs for a parked conversation.
 * One whose child a crash ended mid-turn is woken at once instead, so
 * the turn carries on as a host's restart carries one on; one an
 * operator's kill or stop ended rests, since that is a person's stop.
 */

import type { RosterEntry } from "../../lib/core/session/roster.ts";
import type { BackendChildren } from "./backend.ts";
import type { ChildPolicy } from "./child-policy.ts";
import {
	askOnce,
	childRefused,
	childUnreachable,
	madeByHost,
	reach,
} from "./child-requests.ts";
import {
	ANSWERS_WITHIN_MS,
	type ChildSupervisor,
	childSupervisor,
	EXITS_WITHIN_MS,
	type KeptRoster,
} from "./child-supervisor.ts";
import type { UnitEnding, Units } from "./child-units.ts";
import type { ChildEnding } from "./child-watch.ts";
import { type HeldChildren, heldChildren, passedOn } from "./children.ts";
import { type ControlReply, hostRefusal } from "./dispatch.ts";
import type { ControlRequest } from "./protocol.ts";
import { versionsMove } from "./what-starts.ts";

/**
 * How long after one whose child went mid-turn is woken a second such
 * ending leaves it resting, so a turn that kills its child each time
 * starts no child after child.
 */
export const WOKEN_AGAIN_AFTER_MS = 10 * 60_000;

/**
 * How many times in `WAKES_COUNTED_OVER_MS` one whose child went
 * mid-turn is woken, so a turn that kills its child each time, however
 * long it takes to, asks the model again only so often. The count is
 * kept in the host's memory, so it holds over one host's run.
 */
export const WAKES_A_DAY = 3;

/** How far back the wakes `WAKES_A_DAY` counts reach. */
export const WAKES_COUNTED_OVER_MS = 24 * 60 * 60_000;

/**
 * How long an end its child agreed to, or gave no answer to, still owns
 * the child's ending: past the supervisor's wait for an ended child to
 * exit and for a stuck one to answer, so a close's own ending is the
 * close's, while a child that lives on is woken for a later death.
 */
export const END_ASKED_HOLDS_MS = EXITS_WITHIN_MS + ANSWERS_WITHIN_MS;

/** What ends a conversation's turn when its child takes it. */
const ENDS_A_TURN: ReadonlySet<string> = new Set(
	"close release abort".split(" "),
);

/**
 * What systemd's `Result` says of a unit a crash ended: the kernel's OOM
 * killer, an exit with an error, or a core dump.
 */
const CRASH_RESULTS: ReadonlySet<string> = new Set([
	"oom-kill",
	"exit-code",
	"core-dump",
]);

/**
 * The signals a crash ends a process by, which no operator's stop sends.
 * A child's unit runs with a hard core limit of 0, so one of these reads
 * `Result=signal` rather than `core-dump`. SIGKILL, SIGTERM, SIGINT and
 * SIGHUP are a person's, as `kill -9` and `systemctl stop` send.
 */
const CRASH_SIGNALS: ReadonlySet<string> = new Set([
	"SIGSEGV",
	"SIGABRT",
	"SIGBUS",
	"SIGILL",
	"SIGFPE",
]);

/**
 * How a crash ended a child's unit, as the journal says it, or undefined
 * when systemd says no crash did, or says nothing.
 */
function crashOf(ending: UnitEnding | undefined): string | undefined {
	if (!ending) return undefined;
	const { result, signal } = ending;
	if (CRASH_RESULTS.has(result))
		return signal ? `${result} by ${signal}` : result;
	if (result === "signal" && signal !== undefined && CRASH_SIGNALS.has(signal))
		return signal;
	return undefined;
}

/** Why a child's unit's ending is no crash, as the journal says it. */
function noCrashOf(ending: UnitEnding | undefined): string {
	if (!ending) return "systemd didn't say how its unit ended";
	const { result, signal } = ending;
	if (result === "timeout")
		return "systemd says its unit's stop timed out, as a stop that had to kill it does";
	if (signal !== undefined)
		return `systemd says ${signal} ended its unit (${result}), as a person's kill or stop does`;
	return `systemd says its unit ended ${result}, which is no crash`;
}

/**
 * An end asked of a conversation's child, for one request op: how many
 * asks of it are still unanswered, and until when an agreed one holds.
 */
interface EndAsked {
	unanswered: number;
	until: number;
}

/** A host's children, as the backend, the server and its stop use them. */
export interface HostedChildren {
	/** What the backend asks to wake, open and resume in children. */
	readonly backend: BackendChildren;
	/** Where each conversation a child runs answers. */
	readonly routes: HeldChildren;
	/** Take up every child an earlier host left running. */
	adopt(): Promise<number>;
	/**
	 * Stop watching children and the policy, leaving each child running
	 * but an untaken warm spare, which runs no conversation and is stopped.
	 */
	close(): void;
}

/** Put a host's children together over its roster and engine. */
export function hostChildren(options: {
	key: string;
	folder: string;
	units: Units;
	policy: ChildPolicy;
	roster: KeptRoster;
	/** Rest a conversation parked, watching its wake: the engine's. */
	restsParked?: (entry: RosterEntry) => boolean;
	/**
	 * Rest one whose child was given up, writing its marker, answering
	 * nothing, or why it can't: the engine's.
	 */
	restGivenUp?: (entry: RosterEntry) => string | undefined;
	report: (error: unknown) => void;
	say?: (line: string) => void;
	/** Wake a held conversation, as a message to it does: the backend's. */
	wake?: (sessionId: string) => Promise<void>;
	/**
	 * Whether the host runs a conversation itself, which a wake may have
	 * started there rather than in a child.
	 */
	hostRuns?: (sessionId: string) => boolean;
	/**
	 * Whether the host is stopping, or its start failed, when a wake it
	 * refuses is as it should be; any other wake that doesn't land is
	 * reported.
	 */
	stopping?: () => boolean;
	/**
	 * Leave a resting conversation for the host's next start to resume,
	 * clearing the park marker naming this host's wake, or answer why it
	 * can't: the engine's.
	 */
	leaveToStart?: (entry: RosterEntry) => string | undefined;
	/** For tests: the clock a wake's spacing is read by. */
	now?: () => number;
	/** A child's conversation became another, as its supervisor heard. */
	became?: (previousId: string, nextId: string) => void;
	/** For tests: the supervisor's own timings. */
	timings?: Pick<
		Parameters<typeof childSupervisor>[0],
		"listensWithinMs" | "answersWithinMs" | "exitsWithinMs"
	>;
}): HostedChildren {
	const routes = heldChildren();
	const { roster, policy, report } = options;
	const supervisor: ChildSupervisor = childSupervisor({
		key: options.key,
		folder: options.folder,
		units: options.units,
		routes,
		roster,
		report,
		...(options.say ? { say: options.say } : {}),
		spares: () => policy.spares?.() ?? false,
		spareMoved: versionsMove(),
		ended: (sessionId, why, busy, elsewhere, ending) => {
			// A stale child's ending leaves the marks of the child that runs
			// its conversation now, which were asked of that one.
			const endAsked = !elsewhere && endWasAsked(sessionId);
			const cutOff = why === "failed" && busy;
			// Its close, release or abort failed with it, so carrying the turn
			// on would undo what the person asked; they ask again.
			if (cutOff && endAsked)
				options.say?.(
					`${sessionId}: its child failed mid-turn as it was asked to end it or its turn, so it rests until it is asked for`,
				);
			const waking = cutOff && !endAsked && mayWake(sessionId);
			// One the roster no longer holds is closed or released: nothing wakes.
			const held = rest(sessionId, why, waking);
			if (waking && held) wakeCutOff(sessionId, ending);
		},
		// An abort's turn is over, whether or not its answer came.
		atRest: (sessionId) => abortsAnswered(sessionId),
		// Given up before it ran there, so it never parked: still held, and
		// no child of it is left to end as it was asked.
		gaveUp: (sessionId) => {
			forgetEnds(sessionId);
			restGivenUp(sessionId);
		},
		// No ending of a forsaken child is heard, so none reads these.
		forsook: (sessionId) => forgetEnds(sessionId),
		// Its child ends as what it became, so no ending reads these again.
		became: (previousId, nextId) => {
			forgetEnds(previousId);
			options.became?.(previousId, nextId);
		},
		...options.timings,
	});

	// One left parked, or whose child failed, is still held: the host
	// watches its wake again so a message or a window brings it back.
	// One restsParked declines, as one with no marker from this boot,
	// rests as given up, which writes the marker a park writes, or says
	// why it can't: on 23 November two children ended parked that
	// restsParked declined, and a hub slept unwatched for 19 minutes
	// until a window came.
	// Answers whether the roster still holds it.
	function rest(sessionId: string, why: ChildEnding, waking: boolean): boolean {
		if (why !== "parked" && why !== "failed") return true;
		const entry = roster.entries().find((held) => held.sessionId === sessionId);
		if (!entry) return false;
		try {
			if (options.restsParked?.(entry)) return true;
			const refused = options.restGivenUp
				? options.restGivenUp(entry)
				: "this engine rests none given up";
			if (refused === undefined) return true;
			options.say?.(
				waking
					? `${sessionId}: its child ended ${why}, and nothing watches its wake, as ${refused}, so it is woken now instead, if systemd says a crash ended it`
					: `${sessionId}: its child ended ${why}, and nothing watches its wake until it is asked for, as ${refused}`,
			);
		} catch (error) {
			report(error);
		}
		return true;
	}

	// A child that failed while busy, as one killed mid-turn does, left
	// words or a run nobody answered. Rested, it waited for a window or a
	// message, though a host's own restart carries every such run on. It
	// is woken at once, as a message wakes one, when systemd says a crash
	// ended its unit (crashOf), unless one woken so within
	// WOKEN_AGAIN_AFTER_MS failed the same way, or it was woken so
	// WAKES_A_DAY times in the day before. One a person's kill or stop
	// ended, or whose ending systemd won't say, rests: an emergency stop
	// of a turn gone wrong must not start it again. A child that says it
	// failed while busy exits with an error, so it is woken too, since no
	// word says which turn it left. Each conversation's wakes are kept
	// only for that day, by its id in either case, as the supervisor takes
	// either case as one. A wake is counted, and said, once it lands and
	// a child or the host runs the conversation, so one that started
	// nothing spends none of the spacing; while systemd is asked and the
	// wake lands, the conversation is in `landing`, so two endings never
	// both wake it.
	const wokenAt = new Map<string, number[]>();
	const landing = new Set<string>();
	// Each conversation, by its id in either case, whose child was asked
	// to end it or its turn, with one mark for each op asked: it holds while
	// an ask of that op is unanswered, and for END_ASKED_HOLDS_MS once the
	// child agreed to one, so a child that dies as it is asked wakes nothing.
	// One whose connect failed, or whose answer couldn't be read, as when
	// its asker hung up once it was sent, may still hold the ask, so it
	// stays unanswered until the child ends, or for an
	// abort, which never ends the child, until the child says the turn is
	// over: a child that lives on then rests at a death in that turn rather
	// than carry on a turn the person may have closed, and is woken at a
	// death in a later one. An abort's mark goes then even once it was
	// agreed, as the turn it ended is over. One whose window left before
	// it was sent holds nothing. A refusal answers only its own ask, and
	// the child's ending takes every mark.
	const endsAsked = new Map<string, Map<string, EndAsked>>();
	const now = options.now ?? Date.now;
	function asking(
		sessionId: string,
		op: string,
	): ((reply: ControlReply | undefined) => void) | undefined {
		if (!ENDS_A_TURN.has(op)) return undefined;
		const id = sessionId.toLowerCase();
		const marks = endsAsked.get(id) ?? new Map<string, EndAsked>();
		endsAsked.set(id, marks);
		const mark = marks.get(op) ?? {
			unanswered: 0,
			until: Number.NEGATIVE_INFINITY,
		};
		mark.unanswered += 1;
		marks.set(op, mark);
		return (reply) => {
			// Taken back since, by the child's ending or its turn's.
			if (endsAsked.get(id) !== marks || marks.get(op) !== mark) return;
			// Not reached, or unread as its asker left: the child may hold it still.
			// A child's own refusal may carry the same code, and is a refusal,
			// as is one the host passes on as not reached.
			if (
				reply !== undefined &&
				!reply.ok &&
				madeByHost(reply) &&
				!childRefused(reply)
			)
				return;
			mark.unanswered -= 1;
			const at = now();
			if (reply?.ok) mark.until = Math.max(mark.until, at + END_ASKED_HOLDS_MS);
			if (mark.unanswered > 0 || mark.until > at) return;
			marks.delete(op);
			if (marks.size === 0) endsAsked.delete(id);
		};
	}
	function abortsAnswered(sessionId: string): void {
		const id = sessionId.toLowerCase();
		const marks = endsAsked.get(id);
		if (!marks) return;
		marks.delete("abort");
		if (marks.size === 0) endsAsked.delete(id);
	}
	function forgetEnds(sessionId: string): void {
		endsAsked.delete(sessionId.toLowerCase());
	}
	function endWasAsked(sessionId: string): boolean {
		const id = sessionId.toLowerCase();
		const marks = endsAsked.get(id);
		endsAsked.delete(id);
		const at = now();
		return [...(marks?.values() ?? [])].some(
			(mark) => mark.unanswered > 0 || mark.until > at,
		);
	}
	// Whether one whose child failed mid-turn is woken, saying why not.
	function mayWake(sessionId: string): boolean {
		if (!options.wake) return false;
		const at = now();
		const id = sessionId.toLowerCase();
		if (landing.has(id)) {
			options.say?.(
				`${sessionId}: its child failed mid-turn as its last wake was still landing, so it rests until it is asked for`,
			);
			return false;
		}
		const recent = (wokenAt.get(id) ?? []).filter(
			(one) => at - one < WAKES_COUNTED_OVER_MS,
		);
		if (recent.length > 0) wokenAt.set(id, recent);
		else wokenAt.delete(id);
		const last = recent.at(-1);
		if (last !== undefined && at - last < WOKEN_AGAIN_AFTER_MS) {
			options.say?.(
				`${sessionId}: its child failed mid-turn again within ${WOKEN_AGAIN_AFTER_MS / 60_000} minutes of its last wake, so it rests until it is asked for`,
			);
			return false;
		}
		if (recent.length >= WAKES_A_DAY) {
			options.say?.(
				`${sessionId}: its child failed mid-turn after ${WAKES_A_DAY} wakes for that in a day, so it rests until it is asked for`,
			);
			return false;
		}
		return true;
	}

	// Wakes one mayWake let wake, once it rests, so its wake stays watched,
	// and once systemd says a crash ended its child. Every step's failure,
	// a wake that throws as it is asked among them, is reported, so none
	// escapes into the watch's close or leaves the conversation landing.
	function wakeCutOff(
		sessionId: string,
		ending: Promise<UnitEnding | undefined>,
	): void {
		const { wake } = options;
		if (!wake) return;
		const id = sessionId.toLowerCase();
		landing.add(id);
		ending
			.then(async (how) => {
				const crash = crashOf(how);
				if (crash === undefined) {
					options.say?.(
						`${sessionId}: its child failed mid-turn, but ${noCrashOf(how)}, so it rests until it is asked for`,
					);
					return;
				}
				try {
					await wake(sessionId);
				} catch (error) {
					wakeRefused(sessionId, error);
					return;
				}
				if (!runs(sessionId)) {
					options.say?.(
						`${sessionId}: its wake after its child failed mid-turn started nothing, as the roster no longer holds it or an end was asked since`,
					);
					return;
				}
				wokenAt.set(id, [...(wokenAt.get(id) ?? []), now()]);
				options.say?.(
					`${sessionId}: its child failed mid-turn (${crash}), so it is woken to carry the turn on`,
				);
			})
			.catch(report)
			.finally(() => landing.delete(id));
	}

	// Whether a child or the host runs the conversation now.
	function runs(sessionId: string): boolean {
		return (
			routes.routeOf(sessionId) !== undefined ||
			(options.hostRuns?.(sessionId) ?? false)
		);
	}

	// A host stopping, or whose start failed, refuses every wake, as it
	// should, so that is only said, and the conversation is left for the
	// next start to resume, as a restart carries other cut-off turns on;
	// any other refusal, as a slot that won't free, is a fault reported too.
	function wakeRefused(sessionId: string, error: unknown): void {
		const why = error instanceof Error ? error.message : String(error);
		if (!options.stopping?.()) {
			options.say?.(
				`${sessionId}: its wake after its child failed mid-turn didn't land: ${why}, so it rests until it is asked for`,
			);
			report(error);
			return;
		}
		const kept = leftToStart(sessionId);
		options.say?.(
			kept === undefined
				? `${sessionId}: its wake after its child failed mid-turn didn't land, as the host is stopping (${why}), so the host's next start takes it up`
				: `${sessionId}: its wake after its child failed mid-turn didn't land, as the host is stopping (${why}), and ${kept}, so it rests until it is asked for`,
		);
	}

	// Leaves one for the next start, answering why it can't.
	function leftToStart(sessionId: string): string | undefined {
		const entry = roster.entries().find((held) => held.sessionId === sessionId);
		if (!entry) return "the roster no longer holds it";
		try {
			return options.leaveToStart
				? options.leaveToStart(entry)
				: "this engine leaves none to its next start";
		} catch (error) {
			report(error);
			return `its marker couldn't be cleared: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	// One whose child was given up never parked, so restsParked would
	// decline it: it rests as given up, its marker written as a park's.
	function restGivenUp(sessionId: string): void {
		const entry = roster.entries().find((held) => held.sessionId === sessionId);
		if (!entry) return;
		try {
			const refused = options.restGivenUp
				? options.restGivenUp(entry)
				: "this engine rests none given up";
			if (refused !== undefined)
				options.say?.(
					`${sessionId}: its child was given up, and nothing watches its wake until it is asked for, as ${refused}`,
				);
		} catch (error) {
			report(error);
		}
	}

	// The policy moved it, so a child that can't start says so: on a
	// machine with no child unit, systemd's own refusal names no policy.
	async function resumed(entry: RosterEntry, woken: boolean, bounded = false) {
		try {
			return await supervisor.resume(entry, woken, bounded);
		} catch (error) {
			throw new Error(
				`${entry.sessionId} moves to a process of its own, as children.json says, which didn't start: ${String(error)}`,
				{ cause: error },
			);
		}
	}

	// Asked once of the child, as the server asks a routed request.
	async function ask(sessionId: string, request: ControlRequest) {
		const route = routes.routeOf(sessionId);
		if (!route) throw new Error(`Conversation is not hosted: ${sessionId}`);
		const settle = asking(sessionId, request.op);
		let reply: ControlReply;
		try {
			reply = await askOnce(
				await reach(route.socket),
				`${JSON.stringify(passedOn(request, route))}\n`,
				request.id,
				report,
			);
		} catch (error) {
			// Not reached: it may have died as it was asked.
			settle?.(childUnreachable(request.id));
			throw error;
		}
		settle?.(reply);
		if (!reply.ok) throw hostRefusal(reply.error.code, reply.error.message);
		return reply.result;
	}

	return {
		backend: {
			moves: (sessionId) => policy.moves(sessionId),
			opens: () => policy.opens(),
			running: (sessionId) =>
				routes.listed().find((held) => held.sessionId === sessionId),
			resume: resumed,
			hurry: (sessionId) => supervisor.hurry(sessionId),
			giveUp: (sessionId) => supervisor.giveUp(sessionId),
			begin: (request, taken) => supervisor.begin(request, taken),
			ask,
			left: (sessionId) => supervisor.left(sessionId),
		},
		routes: {
			...routes,
			asking: (request) =>
				"sessionId" in request
					? asking(request.sessionId, request.op)
					: undefined,
		},
		adopt: () => supervisor.adopt(),
		close() {
			supervisor.close();
			policy.close();
		},
	};
}
