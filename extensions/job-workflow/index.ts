/**
 * Job workflow extension: hosts background jobs and says each one's
 * result to the model when the session can take it.
 *
 * A producer finds the host over the bus (`lib/jobs`), starts a job,
 * and finishes it when the work ends. The result waits in the outbox
 * until no run, compaction or submitted prompt is under way, and goes
 * out as a prompt of its own. `/jobs` lists what is running and stops
 * one for the person; the deferred `jobs` tool does the same for the
 * agent. A reload hands the jobs to the runtime it starts, still running,
 * and a rollover to the fresh session carrying the conversation on. A
 * move to a host hands it the jobs that can be carried, still running,
 * through the session's log (moved.ts); any other end of the session
 * stops them, and writes the results it hadn't said there for its next
 * start to say. A bash job is also recorded beside its call as it runs
 * (recorded.ts), so a kill that writes nothing, as of a host systemd
 * gave up waiting on, leaves the next start a call to take up. A line
 * the person types during a run is said on the bus for calls that can
 * move, and pi's working line says what it waits on (typed-line.ts).
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	hosted,
	sessionKeyOf,
	withSession,
} from "../../lib/core/session/index.ts";
import { recordCrashes } from "../../lib/internal/session/crash-record.ts";
import type { CutOff } from "../../lib/internal/session/cut-off-record.ts";
import { isPersonText } from "../../lib/internal/session/driven.ts";
import { runStarted } from "../../lib/internal/session/first-prompt.ts";
import { carriedOnIn } from "../../lib/internal/session/log-header.ts";
import { jobIdsIn } from "../../lib/jobs/report.ts";
import { answerSteerWaiting, saySteered } from "../../lib/jobs/steer.ts";
import { offerCarried } from "../../lib/jobs/take-up.ts";
import { isOthersSteerText } from "../../lib/mesh/steer.ts";
import { sessionIdOf } from "./carry.ts";
import { showJobs } from "./command.ts";
import {
	CARRIED_RUN_RECHECK_MS,
	CARRIED_RUN_WAIT_MS,
	CUT_OFF_ENTRY,
	carriedRunFailedText,
	carriedRunIn,
	carriedRunWent,
	cutOffIn,
	type EndWatch,
	endedRecord,
	leftDead,
	resumeText,
	type SignalSource,
	watchSignals,
	watchStamps,
} from "./cut-off.ts";
import { type KeptWait, keepWait, takeKeptWait } from "./kept-wait.ts";
import { type JobSession, openSession } from "./lifecycle.ts";
import {
	carriedIn,
	carryAway,
	keepUnsaid,
	movingOn,
	sayCarried,
	sayTakenUp,
	strandedIn,
	type TakingUp,
	takeUp,
} from "./moved.ts";
import { recordedCarry } from "./recorded.ts";
import {
	endedJobs,
	endedWithHostText,
	type RunningNote,
	takeEndedNote,
} from "./running.ts";
import { type ShownReports, shownReports } from "./shown.ts";
import { registerJobsTool } from "./tool.ts";
import { type TypedLine, typedLine } from "./typed-line.ts";

/** The text of a user message, however pi carried it. */
function textOf(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	if (!("role" in message)) return undefined;
	// A user message, or a result steered into a run as a custom one.
	if (message.role !== "user" && message.role !== "custom") return undefined;
	if (!("content" in message)) return undefined;
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	return content
		.map((part: unknown) =>
			typeof part === "object" &&
			part !== null &&
			"text" in part &&
			typeof part.text === "string"
				? part.text
				: "",
		)
		.join("");
}

/**
 * The text of every user message in a session's history: none when it
 * can't be read, since that only costs one repeat a turn.
 */
function* userTexts(ctx: {
	sessionManager?: { getBranch?(): readonly unknown[] };
}): Generator<string> {
	let branch: readonly unknown[];
	try {
		branch = ctx.sessionManager?.getBranch?.() ?? [];
	} catch {
		return;
	}
	for (const entry of branch) {
		if (typeof entry !== "object" || entry === null) continue;
		if (!("message" in entry)) continue;
		const text = textOf(entry.message);
		if (text !== undefined) yield text;
	}
}

/**
 * Leave a record that a signal or an uncaught error ended the session
 * with work under way, for the session to be told when it returns
 * (cut-off.ts).
 */
function recordCutOff(
	pi: ExtensionAPI,
	session: JobSession | undefined,
	ctx: ExtensionContext,
): void {
	let running: boolean;
	try {
		running = !ctx.isIdle();
	} catch {
		// A context that can't say is taken as idle: a job still says why.
		running = false;
	}
	const jobs = (session?.jobs.list() ?? [])
		.filter((job) => job.state === "running")
		.map((job) => ({ id: job.id, label: job.spec.label }));
	// A host parks a run it stops and carries it on at the next start (cut-off.ts).
	const record = endedRecord(running, jobs, Date.now(), hosted() !== undefined);
	if (record === undefined) return;
	try {
		pi.appendEntry(CUT_OFF_ENTRY, record);
	} catch {
		// A session that can't be written as it ends is read on its return
		// from where its log stops, as a killed one is.
	}
}

/** The log a session writes, or nothing when it keeps none or can't say. */
function sessionFileOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionFile();
	} catch {
		// A context without a session manager: no log to be carried on from.
		return undefined;
	}
}

/**
 * What a returning session's last pi noted running, if that pi has gone
 * (running.ts): read before this session's own jobs note again.
 */
function endedNoteOf(ctx: ExtensionContext): RunningNote | undefined {
	const id = sessionIdOf(ctx);
	return id === undefined ? undefined : takeEndedNote(id);
}

/**
 * Give a returning session a turn when the machine cut it off, or when
 * jobs its last pi noted running ended with it and nothing took them up.
 */
function resumeIfCutOff(
	session: JobSession,
	ctx: ExtensionContext,
	ended?: RunningNote,
): void {
	const branch = branchOf(ctx);
	// Only a host carries a parked run on; plain pi takes nothing up.
	const held = new Set(session.jobs.list().map((job) => job.id));
	const lost = endedJobs(ended, held);
	// Never reported, so no history reserves their ids for a new job.
	session.jobs.reserve(lost.map((job) => job.id));
	const cut =
		branch === undefined
			? undefined
			: leftDead(cutOffIn(branch, hosted() !== undefined), held);
	if (cut === undefined) {
		// A kill while it waited on these left a log that reads as idle:
		// each is said as its own result, which starts the turn.
		for (const job of lost)
			session.outbox.post({
				jobId: job.id,
				label: job.label,
				text: endedWithHostText(job),
			});
		return;
	}
	// A log that stops mid-run names no jobs; the note says which died.
	const told = cut.jobs.length === 0 ? { ...cut, jobs: lost } : cut;
	session.outbox.post({
		jobId: "cut-off",
		label: "the machine ended this session",
		text: resumeText(told, clockTime),
	});
}

/**
 * In a host, wait for the run the last host carried on to show, and
 * tell the session it was cut off if it never does: on 14 November the
 * next host failed a carried run, and with nothing said the session sat
 * until a mesh message came. The run settling says whether it showed;
 * a run that never starts is told once `CARRIED_RUN_WAIT_MS`, half an
 * hour, is up, as is a log the host had nothing to carry on for, since
 * no extension hears that; a session busy then, or with a run under
 * way, looks again each `CARRIED_RUN_RECHECK_MS`. `ending` ends the wait
 * before the clock tells. A wait `kept` through a reload goes on where
 * it stood. Answers the wait, or nothing when no carried run is owed.
 */
function awaitCarriedRun(
	opened: JobSession,
	ctx: ExtensionContext,
	current: () => JobSession | undefined,
	ending: (wait: CarriedWait) => void,
	kept?: KeptWait,
): CarriedWait | undefined {
	if (hosted() === undefined) return undefined;
	const branch = branchOf(ctx);
	if (branch === undefined) return undefined;
	const cut = kept?.cut ?? carriedRunIn(branch);
	if (cut === undefined) return undefined;
	// Only what comes after the return shows the run: a log that stops
	// mid-run ends on a tool call or result of its own.
	const wait: CarriedWait = {
		opened,
		cut,
		since: kept?.since ?? branch.length,
		started: kept?.started,
		typed: kept?.typed,
		endsAt: 0,
	};
	// A host routes what the session says by the conversation it runs in,
	// which a timer's callback must name again.
	const key = sessionKeyOf(ctx);
	const lookIn = (ms: number): void => {
		wait.endsAt = Date.now() + ms;
		wait.timer = setTimeout(
			() =>
				withSession(key, () => {
					// A run under way says how it went as it settles, unless it
					// answers nothing, so the wait looks again until it rests.
					if (wait.started || !idle(ctx)) return lookIn(CARRIED_RUN_RECHECK_MS);
					ending(wait);
					tellIfCarriedRunLost(wait, ctx, current);
				}),
			ms,
		);
		// The wait never holds a host up that is otherwise ready to end.
		wait.timer.unref();
	};
	lookIn(kept ? Math.max(0, kept.endsAt - Date.now()) : CARRIED_RUN_WAIT_MS);
	return wait;
}

/** A returning hosted session's wait on the run its last host carried on. */
interface CarriedWait {
	readonly opened: JobSession;
	/** The cut-off found as the session returned. */
	readonly cut: CutOff;
	/** The branch's length as the session returned. */
	readonly since: number;
	/** Whether a run has started since the return. */
	started?: boolean;
	/**
	 * Whether the person has typed since the return: a prompt an
	 * extension gives, as a mesh message or a job's report is, isn't them.
	 */
	typed?: boolean;
	/** When the clock next tells, in ms since the epoch. */
	endsAt: number;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * Tell a session its carried run never showed, or ended in an error,
 * if no other answer has come since `wait` began and the person has
 * typed nothing since.
 */
function tellIfCarriedRunLost(
	wait: CarriedWait,
	ctx: ExtensionContext,
	current: () => JobSession | undefined,
): void {
	const { opened, cut, since } = wait;
	if (current() !== opened || wait.typed) return;
	const branch = branchOf(ctx);
	if (branch === undefined) return;
	const went = carriedRunWent(branch, since);
	if (went === "answered") return;
	const told = { at: cut.at, running: cut.running, jobs: cut.jobs };
	opened.outbox.post({
		jobId: "cut-off",
		label: "the machine ended this session",
		text:
			went === "failed"
				? carriedRunFailedText(told, clockTime)
				: resumeText(told, clockTime),
	});
}

/** Whether anything has answered since the return, error or not. */
function carriedRunAnswered(wait: CarriedWait, ctx: ExtensionContext): boolean {
	const branch = branchOf(ctx);
	return (
		branch === undefined || carriedRunWent(branch, wait.since) !== "unseen"
	);
}

/** The session's branch, or nothing when it can't say. */
function branchOf(ctx: ExtensionContext): readonly unknown[] | undefined {
	try {
		return ctx.sessionManager.getBranch();
	} catch {
		// No history to read: nothing was carried on in it.
		return undefined;
	}
}

/** Whether the session is between runs; one that can't say is taken as busy. */
function idle(ctx: ExtensionContext): boolean {
	try {
		return ctx.isIdle();
	} catch {
		// A context gone stale has no session to tell.
		return false;
	}
}

/**
 * Hand a session moving on, to a host or out of one, the jobs that can
 * go with it, written in its log as it ends (moved.ts).
 */
function carryIfMoving(
	pi: ExtensionAPI,
	session: JobSession,
	ctx: ExtensionContext,
): boolean {
	if (!movingOn(sessionIdOf(ctx))) return false;
	return carry(pi, session, ctx);
}

/**
 * Hand on the jobs that can be carried, written in the session's log,
 * and say on the bus what went, for a host that keeps their work alive.
 */
function carry(
	pi: ExtensionAPI,
	session: JobSession,
	ctx: ExtensionContext,
): boolean {
	const carried = carryAway(
		session.jobs,
		session.outbox,
		(type, data) => pi.appendEntry(type, data),
		Date.now(),
	);
	if (carried === undefined) return false;
	if (carried.jobs.length > 0)
		sayCarried(pi.events, sessionKeyOf(ctx), carried.jobs);
	return true;
}

/**
 * Take up the jobs a move carried into this session, if any wait, and
 * those an earlier take-up left unsaid, which a first look says; then
 * the bash calls it recorded that are still running or ended, which a
 * kill carried nothing of.
 */
function takeUpIfCarried(
	pi: ExtensionAPI,
	session: JobSession,
	ctx: ExtensionContext,
): void {
	// A context with no session manager has no history and no records.
	const id = sessionIdOf(ctx);
	if (id === undefined) return;
	let branch: readonly unknown[] = [];
	try {
		branch = ctx.sessionManager.getBranch();
	} catch {
		// No history to read: nothing was carried into it, though its
		// records may still stand.
	}
	const into: TakingUp = {
		jobs: session.jobs,
		outbox: session.outbox,
		session: id,
		append: (type, data) => pi.appendEntry(type, data),
		offer: (work) => offerCarried(pi.events, work),
		taken: (job) => sayTakenUp(pi.events, job),
	};
	const stranded = strandedIn(branch);
	if (stranded) takeUp(stranded, into);
	const carried = carriedIn(branch);
	if (carried) takeUp(carried, into);
	const held = new Set(session.jobs.list().map((job) => job.id));
	const recorded = recordedCarry(id, held, Date.now());
	// The log says nothing of these: no move wrote them, so none is taken.
	if (recorded) takeUp(recorded, { ...into, append: () => {} });
}

/** The session's key for its crash writer, or one for the process when it can't say. */
function crashKeyOf(ctx: ExtensionContext): string {
	try {
		return sessionKeyOf(ctx);
	} catch {
		// A context with no session manager: plain pi runs one session,
		// so one writer for the process still records its jobs.
		return "process";
	}
}

/** Whether pi holds a typed line until the turn's calls have ended. */
function steersTheRun(event: {
	source: string;
	streamingBehavior?: string;
}): boolean {
	return event.source === "interactive" && event.streamingBehavior === "steer";
}

/** Say on pi's working line what a typed line waits on, or give it back. */
function showWaiting(line: TypedLine, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWorkingMessage(line.words());
}

/** Mark a typed line read, giving pi back its working line if one waited. */
function lineRead(line: TypedLine, ctx: ExtensionContext): void {
	if (!line.waiting()) return;
	line.read();
	showWaiting(line, ctx);
}

/** Why a session started, when it may be one the machine cut off. */
const RETURNS = new Set(["startup", "resume"]);

/** A time as the person's clock says it, hours and minutes. */
const clockTime = (at: number) =>
	new Date(at).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});

/** Where the extension hears signals; the process unless a test says. */
export interface JobWorkflowOptions {
	readonly signals?: SignalSource;
}

export default function jobWorkflow(
	pi: ExtensionAPI,
	options: JobWorkflowOptions = {},
) {
	let session: JobSession | undefined;
	let shown: ShownReports = shownReports([]);
	let signals: EndWatch | undefined;
	let crashes: (() => void) | undefined;
	const line = typedLine();
	let answering: (() => void) | undefined;
	let carriedWait: CarriedWait | undefined;
	/** Stop waiting on a carried run, answering the wait there was. */
	const endCarriedWait = (): CarriedWait | undefined => {
		const wait = carriedWait;
		clearTimeout(wait?.timer);
		carriedWait = undefined;
		return wait;
	};

	pi.on("session_start", (event, ctx) => {
		endCarriedWait();
		answering?.();
		answering = answerSteerWaiting(pi.events, () => line.waiting());
		session?.close();
		// Read before the session opens, since its jobs note again as they change.
		const ended = RETURNS.has(event.reason) ? endedNoteOf(ctx) : undefined;
		session = openSession(pi, ctx, event.reason);
		const history = [...userTexts(ctx)];
		shown = shownReports(history);
		// A session that comes back numbers on from what it reported, so a
		// new job's report never reads as one its history already holds.
		session.jobs.reserve(history.flatMap(jobIdsIn));
		signals?.stop();
		signals = hosted()
			? watchStamps(pi.events, sessionKeyOf(ctx))
			: watchSignals(options.signals ?? process);
		// An uncaught error ends a pi as a kill does, with no signal, and
		// a session waiting on jobs then leaves a log that reads as idle:
		// on 11 November five lanes came back so and sat two hours. A host
		// runs others' conversations too, and listens for itself.
		crashes?.();
		crashes = hosted()
			? undefined
			: recordCrashes(`job-workflow:${crashKeyOf(ctx)}`, () =>
					recordCutOff(pi, session, ctx),
				);
		// A reload is no return, but goes on with the wait it ended.
		const kept =
			event.reason === "reload" ? takeKeptWait(sessionIdOf(ctx)) : undefined;
		if (RETURNS.has(event.reason)) {
			takeUpIfCarried(pi, session, ctx);
			resumeIfCutOff(session, ctx, ended);
		}
		if (RETURNS.has(event.reason) || kept) {
			carriedWait = awaitCarriedRun(
				session,
				ctx,
				() => session,
				(wait) => {
					if (carriedWait === wait) endCarriedWait();
				},
				kept,
			);
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		// A quit with no signal is the session's own end, which a move is.
		let ownQuit = false;
		// Whether a carry wrote the results not yet said, with its jobs.
		let carried = false;
		if (event.reason === "quit") {
			// pi's own signal listener starts the shutdown before the rest
			// are called, so the signal is heard only once this yields. pi
			// awaits this handler before it aborts the run.
			await new Promise((resolve) => setImmediate(resolve));
			if (signals?.signalled()) {
				// Its host's own restart resumes it in the next host, so what
				// can go there goes, and only the rest is recorded cut off.
				if (session && signals.restarting?.())
					carried = carry(pi, session, ctx);
				recordCutOff(pi, session, ctx);
			} else ownQuit = true;
		}
		signals?.stop();
		signals = undefined;
		const wait = endCarriedWait();
		if (wait && event.reason === "reload") {
			const { cut, since, endsAt, started, typed } = wait;
			keepWait(sessionIdOf(ctx), { cut, since, endsAt, started, typed });
		}
		crashes?.();
		crashes = undefined;
		answering?.();
		answering = undefined;
		const successor =
			event.reason === "resume"
				? carriedOnIn(event.targetSessionFile, sessionFileOf(ctx))
				: undefined;
		if (event.reason === "reload") session?.park();
		else if (successor) session?.park(undefined, successor);
		else {
			// A signalled pi kills what it started, so only its own quit carries.
			if (ownQuit && session) carried = carryIfMoving(pi, session, ctx);
			// What it hadn't said is said by the next start, never dropped.
			if (session && !carried)
				keepUnsaid(
					session.outbox,
					(type, data) => pi.appendEntry(type, data),
					Date.now(),
				);
			session?.close();
		}
		session = undefined;
	});

	// A prompt typed during a run is queued by pi, not submitted; the
	// outbox tells the two apart by whether the session is idle.
	pi.on("input", (event, ctx) => {
		// A report already shown, sent again by a runtime pi left running
		// (see shown.ts): dropped, so it costs no turn.
		if (shown.again(event.text)) return { action: "handled" as const };
		session?.outbox.promptSubmitted();
		// A peer's or the machine's steer is no one there to say what next.
		if (
			carriedWait &&
			isPersonText(event.text) &&
			!isOthersSteerText(event.text)
		)
			carriedWait.typed = true;
		if (steersTheRun(event)) {
			line.typed();
			showWaiting(line, ctx);
			saySteered(pi.events);
		}
		return undefined;
	});

	pi.on("tool_execution_start", (event, ctx) => {
		line.started(event.toolCallId, event.toolName);
		if (line.waiting()) showWaiting(line, ctx);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		line.ended(event.toolCallId);
		if (line.waiting()) showWaiting(line, ctx);
	});

	pi.on("agent_start", () => {
		runStarted();
		session?.outbox.runStarted();
		if (carriedWait) carriedWait.started = true;
	});

	pi.on("agent_settled", (event, ctx) => {
		session?.outbox.runSettled(event.aborted);
		lineRead(line, ctx);
		// The first run to settle with an answer since a return decides:
		// one that answered, carried or not, leaves a session that runs on,
		// and one stopped once the person spoke has them there to say what
		// comes next. A settle with no run started, as a compaction's; a run
		// that answered nothing, as one durable refused while it held the
		// carried run (recovery.ts); and a run stopped with no word from the
		// person, as a compaction, a peer's Stop or a bare Escape stops one,
		// leave the carried run to come, and the clock to tell if none does.
		if (!carriedWait?.started) return;
		const undecided = event.aborted
			? !carriedWait.typed
			: !carriedRunAnswered(carriedWait, ctx);
		if (undecided) {
			carriedWait.started = false;
			return;
		}
		const wait = endCarriedWait();
		if (wait && !event.aborted) tellIfCarriedRunLost(wait, ctx, () => session);
	});

	pi.on("message_start", (event, ctx) => {
		if (event.message.role === "user") lineRead(line, ctx);
	});

	pi.on("message_end", (event) => {
		const text = textOf(event.message);
		if (text === undefined) return;
		shown.add(text);
		session?.seen(text);
	});

	pi.registerCommand("jobs", {
		description:
			"List background commands, fleets and review rounds, and stop one",
		handler: (_args, ctx) => showJobs(session?.jobs, ctx),
	});

	registerJobsTool(pi, () => session?.jobs);
}
