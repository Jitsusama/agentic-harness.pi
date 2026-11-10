/**
 * A host as systemd runs it: one realm-kind host for the life of the
 * process. The kind comes from the command line and the realm from the
 * environment the unit gives it; the host says it is ready only once it
 * listens, so nothing started after it finds no socket; and a stop signal
 * parks every conversation and keeps every hold before the process ends.
 * The engine is passed in, so the program that starts this names which.
 */

import { execFile } from "node:child_process";
import type { SessionHost } from "../engine/index.ts";
import { type HostKind, hostRealm } from "./address.ts";
import type { ConversationEngine } from "./backend.ts";
import { type ServingHost, serveHost } from "./serve.ts";

/** The signals that stop a host: systemd's stop, and Ctrl+C by hand. */
const STOP_SIGNALS = ["SIGTERM", "SIGINT"] as const;

/** What a host process is given to run. */
export interface HostRunOptions {
	/** The command line after the program: the host's kind. */
	argv: readonly string[];
	/** The environment the unit gave the process. */
	env: NodeJS.ProcessEnv;
	/** Builds the engine over the host's ownership. */
	engine: (host: SessionHost) => Promise<ConversationEngine>;
	/** Where the process hears its stop signals; the process by default. */
	signals?: { once(signal: string, listener: () => void): unknown };
	/** Says the host is ready; systemd's notify by default. */
	ready?: (env: NodeJS.ProcessEnv) => Promise<void>;
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
	const serving = await serveHost({
		...options.places,
		realm,
		kind,
		engine: options.engine,
		report,
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
	return { serving, stopped };
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

function reportToJournal(error: unknown): void {
	const said = error instanceof Error ? (error.stack ?? error.message) : error;
	process.stderr.write(`pi-host: ${String(said)}\n`);
}
