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
 * The engine is passed in, so the program that starts this names which.
 */

import { execFile } from "node:child_process";
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
	/** Settles once a stop signal has parked every conversation. */
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
	const since = () => `${((Date.now() - began) / MS_PER_SECOND).toFixed(1)} s`;
	const starting = async (step: StartStep) => {
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
		starting,
		runtimeDir: options.env.XDG_RUNTIME_DIR,
	});
	const signals = options.signals ?? process;
	const stopped = new Promise<void>((resolve, reject) => {
		const stop = () => {
			serving.stop().then(resolve, reject);
		};
		for (const signal of STOP_SIGNALS) signals.once(signal, stop);
	});
	try {
		await (options.ready ?? notifyReady)(options.env);
	} catch (error) {
		// systemd waits for readiness until its own timeout and stops the
		// unit then; the host keeps serving what it can until it does.
		report(error);
	}
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
	if (!env.NOTIFY_SOCKET) return Promise.resolve();
	const extension = STEP_ALLOWANCE_MS * MICROSECONDS_PER_MS;
	return new Promise((resolve, reject) => {
		execFile(
			"systemd-notify",
			[`EXTEND_TIMEOUT_USEC=${extension}`, `STATUS=${status}`],
			{ env },
			(error) => (error ? reject(error) : resolve()),
		);
	});
}

/** Write a line about the start to standard error, which the journal keeps. */
function sayToJournal(line: string): void {
	process.stderr.write(`pi-host: ${line}\n`);
}

/** Tell systemd the host listens, when it runs the host as a notify unit. */
function notifyReady(env: NodeJS.ProcessEnv): Promise<void> {
	if (!env.NOTIFY_SOCKET) return Promise.resolve();
	return new Promise((resolve, reject) => {
		execFile("systemd-notify", ["--ready"], { env }, (error) =>
			error ? reject(error) : resolve(),
		);
	});
}

/** Write an error to standard error, which systemd's journal keeps. */
export function reportToJournal(error: unknown): void {
	const said = error instanceof Error ? (error.stack ?? error.message) : error;
	process.stderr.write(`pi-host: ${String(said)}\n`);
}
