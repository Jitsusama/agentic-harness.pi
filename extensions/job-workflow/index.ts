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
 * stops them. A line the person types during a run is said on the bus
 * for calls that can move, and pi's working line says what it waits on
 * (typed-line.ts).
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { hosted, sessionKeyOf } from "../../lib/core/session/index.ts";
import { recordCrashes } from "../../lib/internal/session/crash-record.ts";
import { runStarted } from "../../lib/internal/session/first-prompt.ts";
import { carriedOnIn } from "../../lib/internal/session/log-header.ts";
import { answerSteerWaiting, saySteered } from "../../lib/jobs/steer.ts";
import { offerCarried } from "../../lib/jobs/take-up.ts";
import { sessionIdOf } from "./carry.ts";
import { showJobs } from "./command.ts";
import {
	CUT_OFF_ENTRY,
	cutOffIn,
	type EndWatch,
	endedRecord,
	resumeText,
	type SignalSource,
	watchSignals,
	watchStamps,
} from "./cut-off.ts";
import { type JobSession, openSession } from "./lifecycle.ts";
import {
	carriedIn,
	carryAway,
	movingOn,
	sayCarried,
	sayTakenUp,
	takeUp,
} from "./moved.ts";
import { jobIdsIn } from "./outbox.ts";
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
	const record = endedRecord(running, jobs, Date.now());
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

/** Give a returning session a turn when the machine cut it off. */
function resumeIfCutOff(session: JobSession, ctx: ExtensionContext): void {
	let branch: readonly unknown[];
	try {
		branch = ctx.sessionManager.getBranch();
	} catch {
		// No history to read: nothing to resume.
		return;
	}
	const cut = cutOffIn(branch);
	if (cut === undefined) return;
	session.outbox.post({
		jobId: "cut-off",
		label: "the machine ended this session",
		text: resumeText(cut, clockTime),
	});
}

/**
 * Hand a session moving on, to a host or out of one, the jobs that can
 * go with it, written in its log as it ends (moved.ts).
 */
function carryIfMoving(
	pi: ExtensionAPI,
	session: JobSession,
	ctx: ExtensionContext,
): void {
	if (!movingOn(sessionIdOf(ctx))) return;
	carry(pi, session, ctx);
}

/**
 * Hand on the jobs that can be carried, written in the session's log,
 * and say on the bus what went, for a host that keeps their work alive.
 */
function carry(
	pi: ExtensionAPI,
	session: JobSession,
	ctx: ExtensionContext,
): void {
	const carried = carryAway(
		session.jobs,
		session.outbox,
		(type, data) => pi.appendEntry(type, data),
		Date.now(),
	);
	if (carried === undefined || carried.jobs.length === 0) return;
	sayCarried(pi.events, sessionKeyOf(ctx), carried.jobs);
}

/** Take up the jobs a move carried into this session, if any wait. */
function takeUpIfCarried(
	pi: ExtensionAPI,
	session: JobSession,
	ctx: ExtensionContext,
): void {
	let branch: readonly unknown[];
	try {
		branch = ctx.sessionManager.getBranch();
	} catch {
		// No history to read: nothing was carried into it.
		return;
	}
	const carried = carriedIn(branch);
	if (carried === undefined) return;
	takeUp(carried, {
		jobs: session.jobs,
		outbox: session.outbox,
		session: sessionKeyOf(ctx),
		append: (type, data) => pi.appendEntry(type, data),
		offer: (work) => offerCarried(pi.events, work),
		taken: (job) => sayTakenUp(pi.events, job),
	});
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

	pi.on("session_start", (event, ctx) => {
		answering?.();
		answering = answerSteerWaiting(pi.events, () => line.waiting());
		session?.close();
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
		if (RETURNS.has(event.reason)) {
			takeUpIfCarried(pi, session, ctx);
			resumeIfCutOff(session, ctx);
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		// A quit with no signal is the session's own end, which a move is.
		let ownQuit = false;
		if (event.reason === "quit") {
			// pi's own signal listener starts the shutdown before the rest
			// are called, so the signal is heard only once this yields. pi
			// awaits this handler before it aborts the run.
			await new Promise((resolve) => setImmediate(resolve));
			if (signals?.signalled()) {
				// Its host's own restart resumes it in the next host, so what
				// can go there goes, and only the rest is recorded cut off.
				if (session && signals.restarting?.()) carry(pi, session, ctx);
				recordCutOff(pi, session, ctx);
			} else ownQuit = true;
		}
		signals?.stop();
		signals = undefined;
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
			if (ownQuit && session) carryIfMoving(pi, session, ctx);
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
	});

	pi.on("agent_settled", (event, ctx) => {
		session?.outbox.runSettled(event.aborted);
		lineRead(line, ctx);
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
