/**
 * A host as systemd runs it: one realm-kind host for the life of the
 * process. The kind comes from the command line and the realm from the
 * environment the unit gives it; the host says it is ready only once it
 * listens and has resumed all it held, so nothing started after it finds
 * no socket; and a stop signal parks every conversation and keeps every
 * hold before the process ends.
 *
 * A host resumes everything it holds before it is ready, which takes as
 * long as the machine lets it: on 11 November three restarts each spent
 * over 96 s on 13 s of work while some sixty pis reloaded, and systemd's
 * start timeout killed each. So each step of the start asks systemd for
 * more time from that moment and says where it is, and the journal keeps
 * how long each step took. A step asks again every STEP_RENEW_MS while
 * the loop turns, until STEP_CEILING_MS: on 13 November nineteen resumes
 * took 80 to 135 s each while the ones before them took up their turns,
 * past the single allowance one ask gave, and only a drop-in raising the
 * unit's start timeout kept the host alive. A loop that stops turning asks
 * no more, so systemd still ends a wedged start within the allowance.
 *
 * Once ready, when the unit sets a watchdog, the host pings it from its
 * own loop, so a host whose loop stops turning is restarted with what it
 * holds, while one busy with long turns, which it awaits, never is. A
 * beat that comes late says in the journal how long the loop held.
 *
 * What one conversation throws where nothing caught it is contained to
 * that conversation; anything else stops the host the same way, and its
 * stop then fails. Two throws are only reported: a write to a pipe whose
 * other end has gone, outside every conversation, which says a child
 * ended, not that the host broke; and any throw once a stop has begun,
 * which can't change how that stop ends. On 13 November a language
 * server's writer threw on its closed pipe, the host stopped mid-turn
 * for it, and the stop systemd asked for a moment later exited 1. The
 * engine is passed in, so the program that starts this names which.
 * How a step's ask for more time, the ready, the watchdog's beats and
 * the unit's status are told to systemd is systemd.ts's.
 */

import { join } from "node:path";
import { ambientSession } from "../../lib/core/session/index.ts";
import { stateDir } from "../../lib/internal/paths.ts";
import type { SessionHost } from "../engine/index.ts";
import { type HostKind, hostKey, hostRealm } from "./address.ts";
import type { ConversationEngine, ResumePhase } from "./backend.ts";
import {
	type ChildLife,
	type ChildSlot,
	childRosterSeed,
	oneConversation,
} from "./child.ts";
import { type HoldWatchOptions, watchHolds } from "./hold-watch.ts";
import type { ResumeEnd, Resuming } from "./resume-held.ts";
import type { AdmitAnother } from "./rollout.ts";
import { type ServingHost, type StartStep, serveHost } from "./serve.ts";
import type { ViewerBridge } from "./server.ts";
import {
	describeStep,
	droppedNames,
	firstLine,
	type PhaseEnd,
	phaseTimes,
	readyCount,
	readyStatus,
	stoppingStatus,
} from "./status.ts";
import {
	backstopWithin,
	endWithin,
	stopWithin,
	unparkedLine,
	unparkedMarks,
} from "./stop.ts";
import { type Backstop, backstopStop } from "./stop-backstop.ts";
import {
	keepAlive,
	notifyAlive,
	notifyProgress,
	notifyReady,
	notifyStatus,
	ownUnit,
	PINGS_PER_TIMEOUT,
	READY_TAKEN_MS,
	TOLD_WITHIN_MS,
	watchdogEvery,
} from "./systemd.ts";

/** The signals that stop a host: systemd's stop, and Ctrl+C by hand. */
const STOP_SIGNALS = ["SIGTERM", "SIGINT"] as const;

/** How often a step still under way asks systemd for its allowance again. */
export const STEP_RENEW_MS = 30_000;

/**
 * How long one step may go on asking: over six times the slowest resume
 * yet seen (135 s), so only a step that will never end runs out.
 */
export const STEP_CEILING_MS = 15 * 60_000;

/**
 * How often a ready host looks whether what it serves has changed, for
 * the unit's status: a conversation's coming or going shows within this.
 */
const STATUS_EVERY_MS = 15_000;

/**
 * How often a stop tells its backstop what is still unparked, in ms, so a
 * loop held from then on leaves it at most this stale.
 */
const BACKSTOP_TOLD_EVERY_MS = 1000;

/** No backstop, for a stop whose unit never kills it. */
const UNARMED: Backstop = { held() {}, done() {} };

const MS_PER_SECOND = 1000;

/**
 * The folder, in a host's own state folder, keeping its spins' profiles.
 */
const HELD = "held";

/**
 * The codes of a write to a pipe or stream whose other end has gone: a
 * child that ended, such as a language server, whose writer still had
 * something to say. Only these are let pass outside every conversation.
 */
const CLOSED_PIPE_CODES: ReadonlySet<string> = new Set([
	"EPIPE",
	"ERR_STREAM_DESTROYED",
]);

/** What a host process is given to run. */
export interface HostRunOptions {
	/** The command line after the program: the host's kind. */
	argv: readonly string[];
	/**
	 * The slot a child host was started for, and the life that follows its
	 * one conversation (child.ts): its key, not the command line, names the
	 * host, it serves on the slot's socket from the slot's own folder, and
	 * it stops once its conversation ends.
	 */
	child?: { readonly slot: ChildSlot; readonly life: ChildLife };
	/** The environment the unit gave the process. */
	env: NodeJS.ProcessEnv;
	/** Builds the engine over the host's ownership. */
	engine: (host: SessionHost) => Promise<ConversationEngine>;
	/** The screens viewers attach to; without one, attach is refused. */
	viewer?: (host: SessionHost) => ViewerBridge;
	/** Whether a window views a conversation now, as the screens say. */
	viewed?: (sessionId: string) => boolean;
	/** What a second conversation must pass; serve's rollout gate by default. */
	rollout?: AdmitAnother;
	/** Where the process hears its stop signals; the process by default. */
	signals?: { on(signal: string, listener: () => void): unknown };
	/**
	 * Says the host is ready, with its status; by default systemd's notify,
	 * said again until the unit reads active.
	 */
	ready?: (env: NodeJS.ProcessEnv, status: string) => Promise<void>;
	/**
	 * The systemd unit the host runs as; read from its cgroup by default.
	 * Null leaves the ready unconfirmed: it is said once, as before.
	 */
	unit?: string | null;
	/** How long, in ms, systemd has to take a ready before the host looks; READY_TAKEN_MS by default. */
	readyTaken?: number;
	/**
	 * How long, in ms, each telling of systemd's notify has, but the
	 * watchdog's; TOLD_WITHIN_MS by default.
	 */
	toldWithin?: number;
	/** Says the host's status once it changes; systemd's notify by default. */
	status?: (env: NodeJS.ProcessEnv, status: string) => Promise<void>;
	/** How often the status is looked at, in ms; STATUS_EVERY_MS by default. */
	statusEvery?: number;
	/** How long, in ms, a stop may park before the host ends; stopWithin(env) by default. */
	stopWithin?: number;
	/**
	 * Arms what ends a stop whose loop is held past its bound, from beside
	 * the loop, for stopBackstop(env) ms; a thread that kills the host by
	 * default.
	 */
	backstop?: typeof backstopStop;
	/**
	 * Says the host's loop still turns, when systemd's watchdog watches it,
	 * given how many ms the saying may take; systemd's notify by default.
	 */
	alive?: (env: NodeJS.ProcessEnv, within: number) => Promise<void>;
	/**
	 * Watches what holds the loop, when systemd's watchdog watches it,
	 * beating for a loop asleep in the disk where systemd's notify socket
	 * is named, and answering how to stop; a thread beside the loop by
	 * default.
	 */
	holds?: (watch: HoldWatchOptions) => () => void;
	/**
	 * Says the start still moves and where it is, given the step in words;
	 * systemd's notify by default, extending the start timeout.
	 */
	progress?: (env: NodeJS.ProcessEnv, status: string) => Promise<void>;
	/** How often, in ms, a step under way asks again; STEP_RENEW_MS by default. */
	stepRenewEvery?: number;
	/** How long, in ms, one step may go on asking; STEP_CEILING_MS by default. */
	stepCeiling?: number;
	/** Where each step is logged with its time; standard error by default. */
	say?: (line: string) => void;
	/** Where errors go; standard error, which the journal keeps, by default. */
	report?: (error: unknown) => void;
	/**
	 * Where the process hears a throw nothing caught. Production passes the
	 * process; without one, nothing listens, as in a test.
	 */
	faults?: {
		on(event: "uncaughtException", listener: (error: unknown) => void): unknown;
	};
	/**
	 * Contain a throw made in `sessionId`'s conversation to it, saying
	 * whether it could; one it can't stops the host.
	 */
	contain?: (sessionId: string, error: unknown) => boolean;
	/**
	 * Where conversations may run in a process each, passed on to
	 * serveHost; a child, which runs only its own, never passes it.
	 */
	children?: Parameters<typeof serveHost>[0]["children"];
	/**
	 * Passed on to serveHost, for tests: a host run from a tree is given
	 * its rollout gate, since it has no install to read one from.
	 */
	places?: Pick<
		Parameters<typeof serveHost>[0],
		| "rosterDir"
		| "registryDir"
		| "rejectionLog"
		| "owner"
		| "standing"
		| "rosterWait"
		| "rollout"
	>;
}

/** A running host process, and when it has stopped. */
export interface HostRun {
	readonly serving: ServingHost;
	/**
	 * Settles once a stop signal has parked every conversation, or fails
	 * once a throw nothing could contain has stopped the host. A child's
	 * also fails when its stop ran out of time before its conversation
	 * parked, since its watch already heard it parked.
	 */
	readonly stopped: Promise<void>;
	/** Stop as a stop signal would, answering `stopped`. */
	stop(): Promise<void>;
	/** Whether a stop signal has come, before or during any stop it asked of itself. */
	signalled(): boolean;
}

/**
 * How the journal says a resume ended, so a failed or parked one isn't
 * read as resumed; one that failed says why at its end.
 */
const ENDED_AS: Record<ResumeEnd, string> = {
	resumed: "resumed",
	parked: "left parked",
	unresumed: "could not resume",
	gone: "passed over, no longer held,",
};

/**
 * What serveHost is given for a child: the slot's socket and folder, the
 * roster its slot names, written under the roster's lock, the
 * life that hears its changes and becomings and answers its watch, a
 * gate that keeps it to one conversation, and whether its supervisor
 * woke the conversation it resumes.
 */
function childPlaces(
	slot: ChildSlot,
	life: ChildLife,
): Partial<Parameters<typeof serveHost>[0]> {
	return {
		socketPath: slot.socket,
		rosterDir: slot.folder,
		rosterSeed: childRosterSeed(slot),
		rollout: oneConversation,
		changes: life,
		watch: life.watch,
		becoming: life.becoming,
		woken: (entry) =>
			slot.woken === true && entry.sessionId === slot.held?.sessionId,
	};
}

/**
 * How the start's resume of a child's slot ended: resumed when it runs,
 * failed when it couldn't be resumed or its file was gone, and left
 * parked when it rests as it did before the start.
 */
export function slotResumed(
	serving: Pick<ServingHost, "held" | "dropped" | "unresumed">,
	slot: Pick<ChildSlot, "held">,
): Exclude<ResumeEnd, "gone"> {
	const id = slot.held?.sessionId;
	// First, since a resume whose build fails once registered stays listed, parked.
	const failed =
		serving.dropped.includes(id ?? "") ||
		serving.unresumed.some(({ sessionId }) => sessionId === id);
	if (failed) return "unresumed";
	return serving.held().some((held) => held.id === id) ? "resumed" : "parked";
}

/** The host's kind from its command line, refusing anything else. */
export function hostKind(argv: readonly string[]): HostKind {
	const [kind, ...rest] = argv;
	if ((kind === "attended" || kind === "background") && rest.length === 0)
		return kind;
	throw new Error("Usage: pi-host attended|background");
}

/** Start a host for this process and stop it on a stop signal. */
export async function runHost(options: HostRunOptions): Promise<HostRun> {
	const { child } = options;
	const kind = child ? child.slot.kind : hostKind(options.argv);
	const realm = child ? child.slot.realm : hostRealm(options.env);
	const report = options.report ?? reportToJournal;
	const say = options.say ?? sayToJournal;
	const toldWithin = options.toldWithin ?? TOLD_WITHIN_MS;
	const progress =
		options.progress ??
		((env: NodeJS.ProcessEnv, step: string) =>
			notifyProgress(env, step, toldWithin));
	const began = Date.now();
	const unparked = child
		? unparkedMarks(realm, kind, report, child.slot.folder)
		: unparkedMarks(realm, kind, report);
	const lastStop = unparked.read();
	const seconds = (ms: number) => `${(ms / MS_PER_SECOND).toFixed(1)} s`;
	const since = () => seconds(Date.now() - began);
	// Each conversation being resumed, by its step's number: when it began,
	// when each of its phases ended and how it stops asking for more time,
	// so each says how long it took and where, and a restart of thirty can
	// be sized from one. A few resume at once, so each keeps its own.
	interface UnderWay {
		readonly at: number;
		readonly phases: PhaseEnd[];
		renewing?: () => void;
	}
	const resuming = new Map<number, UnderWay>();
	const mark = (step: Resuming, phase: ResumePhase) => {
		resuming.get(step.number)?.phases.push({ phase, at: Date.now() });
	};
	const finished = (step: Resuming, end: ResumeEnd, reason?: unknown) => {
		const under = resuming.get(step.number);
		if (!under) return;
		resuming.delete(step.number);
		under.renewing?.();
		const now = Date.now();
		const told = end === "unresumed" ? firstLine(reason) : "";
		const why = told ? `: ${told}` : "";
		say(
			`${since()}: ${ENDED_AS[end]} ${step.number} of ${step.of} in ${seconds(now - under.at)}${phaseTimes(under.at, under.phases, now)}${why}`,
		);
	};
	const ask = async (status: string) => {
		try {
			await progress(options.env, status);
		} catch (error) {
			// Without more time the start may still fit systemd's own timeout;
			// it goes on, and the journal says why it could not ask.
			report(error);
		}
	};
	// Stops the roster's or the engine's step asking again, once the next
	// step begins or the start ends; each resume stops its own as it ends.
	let renewing: (() => void) | undefined;
	const starting = async (step: StartStep) => {
		renewing?.();
		renewing = undefined;
		let under: UnderWay | undefined;
		if (step.step === "resume") {
			under = { at: Date.now(), phases: [] };
			resuming.set(step.number, under);
		}
		const status = describeStep(step);
		const left =
			step.step === "resume" && lastStop?.ids.includes(step.sessionId)
				? ` (not parked at the ${clockTime(lastStop.at)} stop)`
				: "";
		say(`${since()}: ${status}${left}`);
		await ask(status);
		const renewal = askWhileUnderWay({
			ask: () => ask(status),
			every: options.stepRenewEvery ?? STEP_RENEW_MS,
			ceiling: options.stepCeiling ?? STEP_CEILING_MS,
			// Resumes overlap, so the journal's tail no longer names one that
			// hangs: it names itself as it stops asking.
			passed: under
				? (ceiling) =>
						say(
							`${since()}: still ${status} after ${seconds(ceiling)}; asking no more, and the start waits on it`,
						)
				: undefined,
		});
		// A resume's end is said only once its start has resolved, so it
		// is still under way here.
		if (under) under.renewing = renewal;
		else renewing = renewal;
	};
	// Whatever still asks once the start ends, ended or not, stops asking.
	const stopRenewing = () => {
		renewing?.();
		for (const under of resuming.values()) under.renewing?.();
	};
	// A stop signal is heard from before the start, for as long as the
	// host lives: one during the start stops it once it serves, and a
	// second while it parks rejoins the stop, where node's own default
	// would kill it by signal, which launchd starts again.
	const signals = options.signals ?? process;
	// A stop the host asks of itself ends it as a signal's would; until
	// the host serves there is nothing to stop, so it is only remembered.
	let stopAsked = (): void => undefined;
	// launchd and systemd count their kill from the first signal, so a
	// stop that only begins once the host serves has that much less time.
	let signalledAt: number | undefined;
	for (const signal of STOP_SIGNALS)
		signals.on(signal, () => {
			signalledAt ??= performance.now();
			stopAsked();
		});
	const sinceSignal = () =>
		signalledAt === undefined ? 0 : performance.now() - signalledAt;
	let serving: ServingHost;
	try {
		serving = await serveHost({
			...options.places,
			realm,
			kind,
			engine: options.engine,
			...(options.viewer ? { viewer: options.viewer } : {}),
			...(options.viewed ? { viewed: options.viewed } : {}),
			...(options.rollout ? { rollout: options.rollout } : {}),
			...(child ? childPlaces(child.slot, child.life) : {}),
			// A child shares its supervisor's key, so that key's policy would
			// move the child's own conversation on again: a child moves none.
			...(options.children && !child ? { children: options.children } : {}),
			report,
			say,
			starting,
			mark,
			finished,
			runtimeDir: options.env.XDG_RUNTIME_DIR,
		});
	} catch (error) {
		child?.life.fail();
		throw error;
	} finally {
		stopRenewing();
	}
	if (child?.slot.held) child.life.resumed(slotResumed(serving, child.slot));
	const status = () => readyStatus(readyCount(serving));
	const tell = (now: string) =>
		options.status
			? options.status(options.env, now)
			: notifyStatus(options.env, now, toldWithin);
	const every = watchdogEvery(options.env);
	const unwatchBeats =
		every === undefined
			? undefined
			: keepAlive({
					ping: (within) => (options.alive ?? notifyAlive)(options.env, within),
					every,
					report,
					held: (late) =>
						say(heldLine(late, every * PINGS_PER_TIMEOUT, serving.held())),
				});
	// A host systemd watches also says what holds its loop, from a thread
	// beside it, since the beats can say only how long; that thread beats
	// for a loop asleep in the disk, which no kill would mend, and profiles
	// one that spins into the host's own state, so the code is named.
	const profile = {
		folder: join(stateDir("host-service"), hostKey(realm, kind), HELD),
	};
	const unwatchHolds =
		every === undefined
			? undefined
			: (options.holds ?? watchHolds)(
					// As the loop's own beats, none where systemd names no socket.
					options.env.NOTIFY_SOCKET
						? { beat: { every, env: options.env }, profile }
						: { profile },
				);
	const unwatch = () => {
		unwatchBeats?.();
		unwatchHolds?.();
	};
	let following: (() => void) | undefined;
	let stopping: Promise<void> | undefined;
	const stop = () => {
		if (stopping) return stopping;
		// A child says why it ends before its socket closes, so its watch hears it.
		child?.life.stopping();
		following?.();
		// Parking many can take a while; the status says so meanwhile, and
		// the watchdog hears the loop still turns until every one is parked.
		const parked = tell(stoppingStatus(serving.held().length))
			.catch(report)
			.then(() => serving.stop());
		const spent = sinceSignal();
		const whole = options.stopWithin ?? stopWithin(options.env);
		const bound = Math.max(0, whole - spent);
		const unparkedIds = () => serving.held().map(({ id }) => id);
		// The bound is a timer on this loop, which a loop held on a CPU never
		// comes back to, as at 04:33 on 18 November; a thread beside it ends
		// the host later, still short of systemd's kill.
		// A loop already held as SIGTERM comes never arms it, since this
		// handler runs on that loop.
		const wholeWithin = backstopWithin(options.env, whole);
		const within =
			wholeWithin === undefined ? undefined : Math.max(0, wholeWithin - spent);
		const backstop: Backstop =
			within === undefined
				? UNARMED
				: (options.backstop ?? backstopStop)({
						within,
						file: unparked.file,
						ids: unparkedIds(),
					});
		const telling = setInterval(
			() => backstop.held(unparkedIds()),
			BACKSTOP_TOLD_EVERY_MS,
		);
		telling.unref();
		let outOfTime: string | undefined;
		stopping = endWithin(parked, bound, (waited) => {
			const held = serving.held();
			outOfTime = unparkedLine(bound, waited, held);
			say(outOfTime);
			unparked.write(held.map(({ id }) => id));
		})
			.finally(() => {
				// The host exits as its stop ends, so nothing is left to end.
				clearInterval(telling);
				backstop.done();
				unwatch();
			})
			.then(() => {
				// A host's next start resumes what it left; a child's supervisor
				// knows only its exit that this one never parked.
				if (child && outOfTime !== undefined) throw new Error(outOfTime);
			});
		return stopping;
	};
	const stopped = new Promise<void>((resolve, reject) => {
		stopAsked = () => {
			stop().then(resolve, reject);
		};
		// A signal heard while the host started stops it now it serves.
		if (signalledAt !== undefined) stopAsked();
		// A child stops once its conversation ends, as a signal would stop it.
		void child?.life.ending.then(stop).then(resolve, reject);
		options.faults?.on("uncaughtException", (error) => {
			const failure = uncontained(error, options.contain);
			if (!failure) return;
			report(error);
			// A stop under way ends as it began; a closed pipe ends nothing.
			if (stopping || closedPipe(error)) return;
			child?.life.fail();
			const ended = () => reject(failure);
			stop().then(ended, (stopFailed: unknown) => {
				report(stopFailed);
				ended();
			});
		});
	});
	try {
		const ready =
			options.ready ??
			((env: NodeJS.ProcessEnv, said: string) =>
				notifyReady(env, said, {
					unit: options.unit === null ? undefined : (options.unit ?? ownUnit()),
					taken: options.readyTaken ?? READY_TAKEN_MS,
					toldWithin,
					say,
					stopping: () => stopping !== undefined,
				}));
		await ready(options.env, status());
	} catch (error) {
		// systemd waits for readiness until its own timeout and stops the
		// unit then; the host keeps serving what it can until it does.
		report(error);
	}
	if (stopping === undefined)
		following = followStatus({
			status,
			said: status(),
			tell,
			every: options.statusEvery ?? STATUS_EVERY_MS,
			report,
		});
	// Every conversation the last stop left is resumed by now, so its
	// mark has said all it can.
	if (lastStop) unparked.clear();
	const named = droppedNames(serving.dropped);
	say(`${since()}: ${status()}${named}, listening on ${serving.path}`);
	return {
		serving,
		stopped,
		stop: () => {
			stopAsked();
			return stopped;
		},
		signalled: () => signalledAt !== undefined,
	};
}

/**
 * Ask again every `every` ms from the host's own loop, until `ceiling` ms
 * after the step began or the answer is called, whichever comes first.
 * An ask still on its way when the next is due is let be. `passed` hears
 * the ceiling once, if it is reached before the answer is called.
 */
function askWhileUnderWay(options: {
	ask: () => Promise<void>;
	every: number;
	ceiling: number;
	passed?: (ceiling: number) => void;
}): () => void {
	const began = performance.now();
	let asking = false;
	const again = setInterval(() => {
		if (performance.now() - began >= options.ceiling) {
			clearInterval(again);
			options.passed?.(options.ceiling);
			return;
		}
		if (asking) return;
		asking = true;
		void options.ask().finally(() => {
			asking = false;
		});
	}, options.every);
	again.unref();
	return () => clearInterval(again);
}

/** Write a line about the start to standard error, which the journal keeps. */
function sayToJournal(line: string): void {
	process.stderr.write(`pi-host: ${line}\n`);
}

/**
 * Whether a throw made outside every conversation is a write to a pipe
 * whose other end has gone; one made in a conversation is its to contain.
 */
function closedPipe(error: unknown): boolean {
	if (ambientSession() !== undefined) return false;
	const code =
		typeof error === "object" && error !== null
			? Reflect.get(error, "code")
			: undefined;
	return typeof code === "string" && CLOSED_PIPE_CODES.has(code);
}

/**
 * Contain a throw nothing caught to the conversation it was made in, as
 * the context it ran in names it, answering why the host must stop when
 * it can't be.
 */
function uncontained(
	error: unknown,
	contain: HostRunOptions["contain"],
): Error | undefined {
	const sessionId = ambientSession();
	if (sessionId !== undefined && contain?.(sessionId, error)) return undefined;
	const said = error instanceof Error ? error.message : String(error);
	return new Error(
		sessionId === undefined
			? `The host threw outside every conversation, so it parked them all and stopped: ${said}`
			: `Conversation ${sessionId} threw with no screen to contain it, so the host parked every conversation and stopped: ${said}`,
		{ cause: error },
	);
}

/**
 * Say how long the loop held past a beat, of the watchdog's `timeout`,
 * and how many of the conversations `held` were mid-turn, so a stall
 * can be laid beside what those turns ran.
 */
function heldLine(
	late: number,
	timeout: number,
	held: readonly { readonly state: string }[],
): string {
	const seconds = (ms: number) => (ms / MS_PER_SECOND).toFixed(1);
	const busy = held.filter(({ state }) => state === "busy").length;
	return `the loop held ${seconds(late)} s past a watchdog beat, of the ${seconds(timeout)} s systemd waits, with ${busy} of ${held.length} conversations mid-turn`;
}

/** A moment's local time as the journal reads it, HH:MM. */
function clockTime(at: number): string {
	const when = new Date(at);
	const two = (part: number) => String(part).padStart(2, "0");
	return `${two(when.getHours())}:${two(when.getMinutes())}`;
}

/**
 * Look at the status every `every` ms and tell it once it has changed
 * from what was last said, until the answer is called. A look reads a
 * list the host already keeps, and systemd hears only a change, so
 * conversations opened, adopted, released or ended show without each
 * of those paths having to say so.
 */
function followStatus(options: {
	status: () => string;
	said: string;
	tell: (status: string) => Promise<void>;
	every: number;
	report: (error: unknown) => void;
}): () => void {
	let said = options.said;
	const look = setInterval(() => {
		const now = options.status();
		if (now === said) return;
		said = now;
		options.tell(now).catch(options.report);
	}, options.every);
	look.unref();
	return () => clearInterval(look);
}

/**
 * Write what the host reports to standard error, which systemd's journal
 * keeps: an error thrown, with its stack and what caused it, or a
 * condition the host noticed, as the one line it was reported as. A
 * condition is never wrapped in a new Error, whose stack would say only
 * where it was reported and read in the journal like a failure.
 */
export function reportToJournal(error: unknown): void {
	process.stderr.write(`pi-host: ${said(error)}\n`);
}

// An error's stack, then its cause's, which holds where a contained throw came from.
function said(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const own = error.stack ?? error.message;
	return error.cause === undefined
		? own
		: `${own}\nCaused by: ${said(error.cause)}`;
}
