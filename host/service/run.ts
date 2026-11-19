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
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { ambientSession } from "../../lib/core/session/index.ts";
import { stateDir } from "../../lib/internal/paths.ts";
import { withPi } from "../../lib/internal/priority/place.ts";
import type { SessionHost } from "../engine/index.ts";
import { type HostKind, hostKey, hostRealm } from "./address.ts";
import type {
	ConversationEngine,
	ResumeEnd,
	ResumePhase,
	Resuming,
} from "./backend.ts";
import { type HoldWatchOptions, watchHolds } from "./hold-watch.ts";
import type { AdmitAnother } from "./rollout.ts";
import { type ServingHost, type StartStep, serveHost } from "./serve.ts";
import type { ViewerBridge } from "./server.ts";
import {
	describeStep,
	droppedNames,
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

/** The signals that stop a host: systemd's stop, and Ctrl+C by hand. */
const STOP_SIGNALS = ["SIGTERM", "SIGINT"] as const;

/**
 * How long systemd is asked to wait from each step a start reaches: the
 * slowest conversation seen took 13 s of work, and this lets one take that
 * at a ninth of a CPU, while a start stuck in one step still ends.
 */
export const STEP_ALLOWANCE_MS = 120_000;

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

/**
 * How many times the host pings systemd's watchdog in each of its
 * timeouts. systemd advises two; four leaves room for a systemd-notify
 * that starts late on a starved machine, as on 11 November, when 13 s of
 * work took 96 s.
 */
const PINGS_PER_TIMEOUT = 4;

/**
 * How late a watchdog beat may come before the journal says the loop
 * held: the longest a live host kept a request waiting through the night
 * of 12 November was 3.3 s, so this names only what passes a busy night.
 */
const LATE_BEAT_MS = 5000;
const HALF = 2;

const MICROSECONDS_PER_MS = 1000;
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
	/** The environment the unit gave the process. */
	env: NodeJS.ProcessEnv;
	/** Builds the engine over the host's ownership. */
	engine: (host: SessionHost) => Promise<ConversationEngine>;
	/** The screens viewers attach to; without one, attach is refused. */
	viewer?: (host: SessionHost) => ViewerBridge;
	/** What a second conversation must pass; serve's rollout gate by default. */
	rollout?: AdmitAnother;
	/** Where the process hears its stop signals; the process by default. */
	signals?: { once(signal: string, listener: () => void): unknown };
	/** Says the host is ready, with its status; systemd's notify by default. */
	ready?: (env: NodeJS.ProcessEnv, status: string) => Promise<void>;
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
	 * once a throw nothing could contain has stopped the host.
	 */
	readonly stopped: Promise<void>;
}

/**
 * How the journal says a resume ended, so a failed or parked one isn't
 * read as resumed; one that failed says why at its end.
 */
const ENDED_AS: Record<ResumeEnd, string> = {
	resumed: "resumed",
	parked: "left parked",
	unresumed: "could not resume",
};

/** The host's kind from its command line, refusing anything else. */
export function hostKind(argv: readonly string[]): HostKind {
	const [kind, ...rest] = argv;
	if ((kind === "attended" || kind === "background") && rest.length === 0)
		return kind;
	throw new Error("Usage: pi-host attended|background");
}

/** Start a host for this process and stop it on the first stop signal. */
export async function runHost(options: HostRunOptions): Promise<HostRun> {
	const kind = hostKind(options.argv);
	const realm = hostRealm(options.env);
	const report = options.report ?? reportToJournal;
	const say = options.say ?? sayToJournal;
	const progress = options.progress ?? notifyProgress;
	const began = Date.now();
	const unparked = unparkedMarks(realm, kind, report);
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
	let serving: ServingHost;
	try {
		serving = await serveHost({
			...options.places,
			realm,
			kind,
			engine: options.engine,
			...(options.viewer ? { viewer: options.viewer } : {}),
			...(options.rollout ? { rollout: options.rollout } : {}),
			report,
			say,
			starting,
			mark,
			finished,
			runtimeDir: options.env.XDG_RUNTIME_DIR,
		});
	} finally {
		stopRenewing();
	}
	const status = () => readyStatus(readyCount(serving));
	const tell = (now: string) =>
		(options.status ?? notifyStatus)(options.env, now);
	const signals = options.signals ?? process;
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
		following?.();
		// Parking many can take a while; the status says so meanwhile, and
		// the watchdog hears the loop still turns until every one is parked.
		const parked = tell(stoppingStatus(serving.held().length))
			.catch(report)
			.then(() => serving.stop());
		const bound = options.stopWithin ?? stopWithin(options.env);
		const unparkedIds = () => serving.held().map(({ id }) => id);
		// The bound is a timer on this loop, which a loop held on a CPU never
		// comes back to, as at 04:33 on 18 November; a thread beside it ends
		// the host later, still short of systemd's kill.
		// A loop already held as SIGTERM comes never arms it, since this
		// handler runs on that loop.
		const within = backstopWithin(options.env, bound);
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
		stopping = endWithin(parked, bound, (waited) => {
			const held = serving.held();
			say(unparkedLine(bound, waited, held));
			unparked.write(held.map(({ id }) => id));
		}).finally(() => {
			// The host exits as its stop ends, so nothing is left to end.
			clearInterval(telling);
			backstop.done();
			unwatch();
		});
		return stopping;
	};
	const stopped = new Promise<void>((resolve, reject) => {
		for (const signal of STOP_SIGNALS)
			signals.once(signal, () => {
				stop().then(resolve, reject);
			});
		options.faults?.on("uncaughtException", (error) => {
			const failure = uncontained(error, options.contain);
			if (!failure) return;
			report(error);
			// A stop under way ends as it began; a closed pipe ends nothing.
			if (stopping || closedPipe(error)) return;
			const ended = () => reject(failure);
			stop().then(ended, (stopFailed: unknown) => {
				report(stopFailed);
				ended();
			});
		});
	});
	try {
		await (options.ready ?? notifyReady)(options.env, status());
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
	return { serving, stopped };
}

/**
 * How often, in ms, to tell systemd's watchdog the loop still turns, when
 * it watches this process; undefined when it doesn't.
 */
export function watchdogEvery(
	env: NodeJS.ProcessEnv,
	pid: number = process.pid,
): number | undefined {
	const timeout = Number(env.WATCHDOG_USEC);
	if (!Number.isFinite(timeout) || timeout <= 0) return undefined;
	// A child given the host's environment isn't the process systemd watches.
	if (env.WATCHDOG_PID !== undefined && Number(env.WATCHDOG_PID) !== pid)
		return undefined;
	return timeout / MICROSECONDS_PER_MS / PINGS_PER_TIMEOUT;
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

/**
 * The first line of why something failed that says anything, to keep a
 * journal entry on one line, or nothing for a reason with no message;
 * the start's report says the rest, stack and all.
 */
function firstLine(reason: unknown): string {
	let text: unknown;
	try {
		text = reason instanceof Error ? reason.message : reason;
	} catch {
		// A message getter that throws says nothing; the report still has the reason.
		text = "";
	}
	if (typeof text !== "string") return "";
	return (
		text
			.split(/\r?\n|\r/)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? ""
	);
}

/**
 * Ask systemd for STEP_ALLOWANCE_MS more from now and show the step as the
 * unit's status, when it runs the host as a notify unit.
 */
function notifyProgress(env: NodeJS.ProcessEnv, status: string): Promise<void> {
	const extension = STEP_ALLOWANCE_MS * MICROSECONDS_PER_MS;
	return tellSystemd(env, [
		`EXTEND_TIMEOUT_USEC=${extension}`,
		`STATUS=${status}`,
	]);
}

/**
 * Run systemd-notify with `args`, when the host runs as a notify unit,
 * from the host's own cgroup. systemd credits a notify to the unit whose
 * cgroup its sender is in, and a hosted conversation's priority-workflow
 * writes every child this process spawns into jobs.service: on 11
 * November the background host's ready went to jobs.service whenever the
 * move landed first, and systemd stopped the host at its start timeout.
 * Given `within` ms, a systemd-notify still running then is killed and
 * the telling fails.
 */
function tellSystemd(
	env: NodeJS.ProcessEnv,
	args: readonly string[],
	within?: number,
): Promise<void> {
	if (!env.NOTIFY_SOCKET) return Promise.resolve();
	const timeout = within === undefined ? {} : { timeout: within };
	return new Promise((resolve, reject) => {
		withPi(() =>
			execFile("systemd-notify", args, { env, ...timeout }, (error) =>
				error ? reject(error) : resolve(),
			),
		);
	});
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
 * Tell systemd the host listens, and what it serves as the unit's status,
 * when it runs the host as a notify unit. Ready alone left the status at
 * the last start step: on 12 November attended still read "building the
 * engine" hours after it started.
 */
function notifyReady(env: NodeJS.ProcessEnv, status: string): Promise<void> {
	return tellSystemd(env, ["--ready", `STATUS=${status}`]);
}

/**
 * Tell systemd's watchdog the host's loop still turns, killing a
 * systemd-notify that hasn't ended `within` ms on.
 */
function notifyAlive(env: NodeJS.ProcessEnv, within: number): Promise<void> {
	return tellSystemd(env, ["WATCHDOG=1"], within);
}

/**
 * Ping every `every` ms from the host's own loop, until the answer is
 * called. A conversation's work is awaited rather than run on the loop,
 * so a turn of any length leaves it free to ping, and only a loop that
 * stops turning goes quiet, for systemd to restart. Each ping is given
 * one beat. One still on its way when the next is due is let be for that
 * beat rather than joined by another, and the beat after pings anyway,
 * so a systemd-notify that never ends can't silence a healthy host.
 * A beat that comes late by more than LATE_BEAT_MS, or half the timeout
 * when that is less, is `held`, so a stall short of a kill leaves a
 * trace saying how long it was, and it pings whatever is on its way: a
 * turn of the loop runs its timers before the poll that reads a ping's
 * end, so the ping before a hold looks unanswered when it may long since
 * have reached systemd. Skipping then would leave systemd waiting the
 * hold and two beats, and a hold of about two beats would end the host
 * after its loop had turned again.
 */
function keepAlive(options: {
	ping: (within: number) => Promise<void>;
	every: number;
	report: (error: unknown) => void;
	held: (late: number) => void;
}): () => void {
	const timeout = options.every * PINGS_PER_TIMEOUT;
	const noted = Math.min(LATE_BEAT_MS, timeout / HALF);
	// The newest ping, and whether it's still on its way and has had its beat.
	let newest = 0;
	let pinging = false;
	let waited = false;
	let last = performance.now();
	const beat = setInterval(() => {
		const now = performance.now();
		const late = now - last - options.every;
		last = now;
		const stalled = late > noted;
		if (stalled) options.held(late);
		if (pinging && !waited && !stalled) {
			waited = true;
			return;
		}
		newest += 1;
		const ping = newest;
		pinging = true;
		waited = false;
		options
			.ping(options.every)
			.catch(options.report)
			.finally(() => {
				if (ping === newest) pinging = false;
			});
	}, options.every);
	beat.unref();
	return () => clearInterval(beat);
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

/** Show what the host serves as the unit's status, once it changes. */
function notifyStatus(env: NodeJS.ProcessEnv, status: string): Promise<void> {
	return tellSystemd(env, [`STATUS=${status}`]);
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
