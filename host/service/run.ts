/**
 * A host as systemd runs it: one realm-kind host for the life of the
 * process. The kind comes from the command line and the realm from the
 * environment the unit gives it; the host says it is ready only once it
 * listens, so nothing started after it finds no socket; and a stop signal
 * parks every conversation and keeps every hold before the process ends.
 *
 * A host resumes everything it holds before it listens, which takes as
 * long as the machine lets it: on 11 November three restarts each spent
 * over 96 s on 13 s of work while some sixty pis reloaded, and systemd's
 * start timeout killed each. So each step of the start asks systemd for
 * more time from that moment and says where it is, and the journal keeps
 * how long each step took.
 *
 * What one conversation throws where nothing caught it is contained to
 * that conversation; anything else stops the host the same way, and its
 * stop then fails. The engine is passed in, so the program that starts
 * this names which.
 */

import { execFile } from "node:child_process";
import { ambientSession } from "../../lib/core/session/index.ts";
import { withPi } from "../../lib/internal/priority/place.ts";
import type { SessionHost } from "../engine/index.ts";
import { type HostKind, hostRealm } from "./address.ts";
import type { ConversationEngine } from "./backend.ts";
import { type ServingHost, type StartStep, serveHost } from "./serve.ts";
import type { ViewerBridge } from "./server.ts";

/** The signals that stop a host: systemd's stop, and Ctrl+C by hand. */
const STOP_SIGNALS = ["SIGTERM", "SIGINT"] as const;

/**
 * How long systemd is asked to wait from each step a start reaches: the
 * slowest conversation seen took 13 s of work, and this lets one take that
 * at a ninth of a CPU, while a start stuck in one step still ends.
 */
export const STEP_ALLOWANCE_MS = 120_000;

const MICROSECONDS_PER_MS = 1000;
const MS_PER_SECOND = 1000;

/**
 * How long a stop for a throw nothing contained may take before the host
 * ends anyway: inside systemd's 60 s stop timeout, so the next host starts
 * from what parked rather than from a kill.
 */
const FAILED_STOP_MS = 45_000;

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
	/** Where the process hears its stop signals; the process by default. */
	signals?: { once(signal: string, listener: () => void): unknown };
	/** Says the host is ready; systemd's notify by default. */
	ready?: (env: NodeJS.ProcessEnv) => Promise<void>;
	/**
	 * Says the start still moves and where it is, given the step in words;
	 * systemd's notify by default, extending the start timeout.
	 */
	progress?: (env: NodeJS.ProcessEnv, status: string) => Promise<void>;
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
	const seconds = (ms: number) => `${(ms / MS_PER_SECOND).toFixed(1)} s`;
	const since = () => seconds(Date.now() - began);
	// The conversation being resumed and when it began, so each says how
	// long it took and a restart of thirty can be sized from one.
	let resuming: { readonly step: StartStep; readonly at: number } | undefined;
	const resumed = () => {
		if (resuming?.step.step !== "resume") return;
		const { number, of } = resuming.step;
		say(
			`${since()}: resumed ${number} of ${of} in ${seconds(Date.now() - resuming.at)}`,
		);
	};
	const starting = async (step: StartStep) => {
		resumed();
		resuming = { step, at: Date.now() };
		const status = describeStep(step);
		say(`${since()}: ${status}`);
		try {
			await progress(options.env, status);
		} catch (error) {
			// Without more time the start may still fit systemd's own timeout;
			// it goes on, and the journal says why it could not ask.
			report(error);
		}
	};
	const serving = await serveHost({
		...options.places,
		realm,
		kind,
		engine: options.engine,
		...(options.viewer ? { viewer: options.viewer } : {}),
		report,
		say,
		starting,
		runtimeDir: options.env.XDG_RUNTIME_DIR,
	});
	const signals = options.signals ?? process;
	let stopping: Promise<void> | undefined;
	const stop = () => {
		stopping ??= serving.stop();
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
			const ended = () => reject(failure);
			// A stop that hangs still ends the host, inside systemd's own timeout.
			setTimeout(ended, FAILED_STOP_MS).unref();
			stop().then(ended, (stopFailed: unknown) => {
				report(stopFailed);
				ended();
			});
		});
	});
	try {
		await (options.ready ?? notifyReady)(options.env);
	} catch (error) {
		// systemd waits for readiness until its own timeout and stops the
		// unit then; the host keeps serving what it can until it does.
		report(error);
	}
	resumed();
	say(
		`${since()}: ready, listening on ${serving.path}` +
			(serving.unresumed.length > 0
				? `, ${serving.unresumed.length} held but not resumed`
				: ""),
	);
	return { serving, stopped };
}

/** A start step in words, as the journal and systemd's status show it. */
export function describeStep(step: StartStep): string {
	return step.step === "engine"
		? "building the engine"
		: `resuming ${step.number} of ${step.of}: ${step.sessionId}`;
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
 */
function tellSystemd(
	env: NodeJS.ProcessEnv,
	args: readonly string[],
): Promise<void> {
	if (!env.NOTIFY_SOCKET) return Promise.resolve();
	return new Promise((resolve, reject) => {
		withPi(() =>
			execFile("systemd-notify", args, { env }, (error) =>
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

/** Tell systemd the host listens, when it runs the host as a notify unit. */
function notifyReady(env: NodeJS.ProcessEnv): Promise<void> {
	return tellSystemd(env, ["--ready"]);
}

/** Write an error, and what caused it, to standard error, which systemd's journal keeps. */
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
