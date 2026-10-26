/**
 * Job workflow extension: hosts background jobs and says each one's
 * result to the model when the session can take it.
 *
 * A producer finds the host over the bus (`lib/jobs`), starts a job,
 * and finishes it when the work ends. The result waits in the outbox
 * until no run, compaction or submitted prompt is under way, and goes
 * out as a prompt of its own. `/jobs` lists what is running and stops
 * one for the person; the deferred `jobs` tool does the same for the
 * agent. A reload hands the jobs to the runtime it starts, still running;
 * any other end of the session stops them.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { showJobs } from "./command.ts";
import {
	CUT_OFF_ENTRY,
	cutOffIn,
	endedRecord,
	resumeText,
	type SignalSource,
	watchSignals,
} from "./cut-off.ts";
import { type JobSession, openSession } from "./lifecycle.ts";
import { type ShownReports, shownReports } from "./shown.ts";
import { registerJobsTool } from "./tool.ts";

/** The text of a user message, however pi carried it. */
function textOf(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	if (!("role" in message) || message.role !== "user") return undefined;
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
 * Leave a record that a signal ended the session with work under way,
 * for the session to be told when it returns (cut-off.ts).
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
	let signals: ReturnType<typeof watchSignals> | undefined;

	pi.on("session_start", (event, ctx) => {
		session?.close();
		session = openSession(pi, ctx, event.reason);
		shown = shownReports(userTexts(ctx));
		signals?.stop();
		signals = watchSignals(options.signals ?? process);
		if (RETURNS.has(event.reason)) resumeIfCutOff(session, ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason === "quit") {
			// pi's own signal listener starts the shutdown before the rest
			// are called, so the signal is heard only once this yields. pi
			// awaits this handler before it aborts the run.
			await new Promise((resolve) => setImmediate(resolve));
			if (signals?.signalled()) recordCutOff(pi, session, ctx);
		}
		signals?.stop();
		signals = undefined;
		if (event.reason === "reload") session?.park();
		else session?.close();
		session = undefined;
	});

	// A prompt typed during a run is queued by pi, not submitted; the
	// outbox tells the two apart by whether the session is idle.
	pi.on("input", (event) => {
		// A report already shown, sent again by a runtime pi left running
		// (see shown.ts): dropped, so it costs no turn.
		if (shown.again(event.text)) return { action: "handled" as const };
		session?.outbox.promptSubmitted();
		return undefined;
	});

	pi.on("agent_start", () => session?.outbox.runStarted());

	pi.on("agent_settled", () => session?.outbox.runSettled());

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
