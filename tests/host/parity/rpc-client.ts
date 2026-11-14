/**
 * Drives a process speaking pi's RPC mode over stdin and stdout, as a
 * screen would: plain pi, or the host with pi's RPC mode as its screen. The
 * process gets only the environment it is given. Every line it prints is
 * kept in a log beside its stderr, and a dialog an extension opens is
 * cancelled, as no one is there to answer it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { deadline } from "./mock-provider.ts";

/** What a recording starts: a command, its arguments, and where. */
export interface Launch {
	readonly command: string;
	readonly args: readonly string[];
}

/** One line the process printed, as JSON. */
export type RpcEvent = Readonly<Record<string, unknown>> & {
	readonly type?: unknown;
};

/** A running RPC process. */
export interface RpcClient {
	/** The process's id, or undefined when it never started. */
	readonly pid: number | undefined;
	/** Send a command and resolve with its successful response. */
	request(command: Record<string, unknown>): Promise<RpcEvent>;
	/** Resolve with the first event from now on that matches, within `withinMs`. */
	wait(
		matches: (event: RpcEvent) => boolean,
		withinMs?: number,
	): Promise<RpcEvent>;
	/** Send a prompt and resolve once the agent settles, within `withinMs`. */
	prompt(message: string, withinMs?: number): Promise<RpcEvent>;
	close(): Promise<void>;
}

/** How long any one event may take, generous for a loaded machine. */
const EVENT_DEADLINE_MS = 180_000;

/** How long a process may take to leave once its input closes. */
const CLOSE_GRACE_MS = 10_000;

/** The dialogs an extension may open that wait on an answer. */
const DIALOGS = new Set(["confirm", "select", "input", "editor"]);

/** Start `launch` in `cwd` with exactly `env`, logging what it prints to `log`. */
export function rpcClient(
	launch: Launch,
	cwd: string,
	env: Readonly<Record<string, string>>,
	log: string,
): RpcClient {
	const child = spawn(launch.command, [...launch.args], {
		cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const listeners = new Set<(event: RpcEvent) => void>();
	const failures = new Set<(error: Error) => void>();
	let exited: Error | undefined;
	let buffer = "";
	let sequence = 0;
	child.stderr.on("data", (chunk) => appendFileSync(`${log}.stderr`, chunk));
	child.stdout.on("data", (chunk) => {
		buffer += String(chunk);
		let end = buffer.indexOf("\n");
		while (end >= 0) {
			heard(buffer.slice(0, end));
			buffer = buffer.slice(end + 1);
			end = buffer.indexOf("\n");
		}
	});
	const fail = (error: Error) => {
		exited ??= error;
		for (const failure of failures) failure(error);
	};
	child.on("error", fail);
	child.on("exit", (code, signal) =>
		fail(new Error(`The process left: ${code}/${signal}`)),
	);

	function heard(line: string): void {
		appendFileSync(log, `${line}\n`);
		let event: RpcEvent;
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed === null || typeof parsed !== "object") return;
			event = { ...parsed };
		} catch {
			// Not a JSON line: pi's RPC output is JSON, anything else is noise kept in the log.
			return;
		}
		if (
			event.type === "extension_ui_request" &&
			typeof event.method === "string" &&
			DIALOGS.has(event.method)
		)
			write(child, {
				type: "extension_ui_response",
				id: event.id,
				cancelled: true,
			});
		for (const listener of listeners) listener(event);
	}

	function wait(
		matches: (event: RpcEvent) => boolean,
		withinMs = EVENT_DEADLINE_MS,
	): Promise<RpcEvent> {
		if (exited) return Promise.reject(exited);
		const found = new Promise<RpcEvent>((done, refuse) => {
			const heardOne = (event: RpcEvent) => {
				if (!matches(event)) return;
				forget();
				done(event);
			};
			const failed = (error: Error) => {
				forget();
				refuse(error);
			};
			const forget = () => {
				listeners.delete(heardOne);
				failures.delete(failed);
			};
			listeners.add(heardOne);
			failures.add(failed);
		});
		return deadline(found, withinMs, "No RPC event came in time");
	}

	async function request(command: Record<string, unknown>): Promise<RpcEvent> {
		const id = `req-${sequence}`;
		sequence += 1;
		const response = wait(
			(event) => event.type === "response" && event.id === id,
		);
		write(child, { ...command, id });
		const answered = await response;
		if (answered.success !== true)
			throw new Error(`Refused: ${JSON.stringify(answered)}`);
		return answered;
	}

	return {
		pid: child.pid,
		request,
		wait,
		prompt: async (message, withinMs) => {
			const settled = wait((event) => event.type === "agent_settled", withinMs);
			// Awaited below; a refusal before then is the request's to report.
			settled.catch(() => undefined);
			await request({ type: "prompt", message });
			return settled;
		},
		close: async () => {
			if (exited) return;
			const left = new Promise((done) => child.once("exit", done));
			child.stdin.end();
			const timer = setTimeout(() => child.kill("SIGKILL"), CLOSE_GRACE_MS);
			await left;
			clearTimeout(timer);
		},
	};
}

function write(child: ChildProcess, message: object): void {
	child.stdin?.write(`${JSON.stringify(message)}\n`);
}
