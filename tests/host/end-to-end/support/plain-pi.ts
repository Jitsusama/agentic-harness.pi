/**
 * A plain pi in the seal, as the rollback opens one: the pi built with
 * the host's patches run as its own CLI, `pi --mode rpc --session
 * <file>`, on a hosted conversation's log, with the scripted model
 * loaded as an extension. Driven over RPC's JSON lines, split on line
 * feeds alone as RPC frames them; what it writes to stderr is kept for a
 * failure.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { isRecord } from "../../../../lib/internal/record.ts";
import type { Seal } from "./seal.ts";

/** The extension that registers the scripted model in a plain pi. */
const SCRIPTED_PROVIDER = resolve(import.meta.dirname, "scripted-provider.ts");

/** How long a plain pi may take to load the harness and answer a command. */
const ANSWER_WAIT_MS = 120_000;

/** How long a plain pi may take to go once told to. */
const STOP_WAIT_MS = 20_000;

/** A plain pi running in the seal. */
export interface PlainPi {
	/** Its process's id, which its presence names as its owner. */
	readonly pid: number;
	/**
	 * Prompt it as the person would, after any turn it is in, once it has
	 * accepted the prompt.
	 */
	prompt(message: string): Promise<void>;
	/** The messages its conversation holds, as its model is handed them. */
	messages(): Promise<readonly unknown[]>;
	/** Its session's id and log. */
	session(): Promise<{ readonly sessionId: string; readonly file: string }>;
	/** Stop it, waiting until it has gone. */
	stop(): Promise<void>;
	/** What it wrote to stderr. */
	errors(): string;
}

/** pi's answer to one command. */
interface Reply {
	readonly success: boolean;
	readonly error?: string;
	readonly data?: unknown;
}

/**
 * Start a plain pi under `seal` on the pi in `packageDir`, in `cwd`:
 * resuming the session `file`, or on a fresh session without one.
 */
export function startPlainPi(options: {
	seal: Seal;
	packageDir: string;
	file?: string;
	cwd: string;
}): PlainPi {
	const child = spawn(
		process.execPath,
		[
			join(options.packageDir, "dist/bundle/cli.js"),
			"--mode",
			"rpc",
			...(options.file ? ["--session", options.file] : []),
			"--extension",
			SCRIPTED_PROVIDER,
		],
		{
			cwd: options.cwd,
			env: { ...options.seal.env, PI_HOST_PACKAGE_DIR: options.packageDir },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const replies = repliesOf(child);
	let sent = 0;
	/** Send pi a command, and wait for its reply, failing on a refusal. */
	const command = async (type: string, fields: object = {}): Promise<Reply> => {
		sent += 1;
		const id = `${type}-${sent}`;
		const reply = replies(id);
		child.stdin?.write(`${JSON.stringify({ id, type, ...fields })}\n`);
		const answer = await reply;
		if (!answer.success)
			throw new Error(`pi refused ${type}: ${answer.error ?? "no reason"}`);
		return answer;
	};
	return {
		pid: child.pid ?? 0,
		async prompt(message) {
			await command("prompt", { message, streamingBehavior: "followUp" });
		},
		async messages() {
			const { data } = await command("get_messages");
			return isRecord(data) && Array.isArray(data.messages)
				? data.messages
				: [];
		},
		async session() {
			const { data } = await command("get_state");
			if (
				!isRecord(data) ||
				typeof data.sessionId !== "string" ||
				typeof data.sessionFile !== "string"
			)
				throw new Error("pi's state names no session and log");
			return { sessionId: data.sessionId, file: data.sessionFile };
		},
		async stop() {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const gone = once(child, "exit");
			child.kill("SIGTERM");
			const timer = setTimeout(() => child.kill("SIGKILL"), STOP_WAIT_MS);
			await gone;
			clearTimeout(timer);
		},
		errors: () => stderr,
	};
}

/**
 * The replies `child` writes, by command id: a promise for each id
 * asked, settled by its response, or failed once the wait runs out or
 * pi ends first.
 */
function repliesOf(child: ChildProcess): (id: string) => Promise<Reply> {
	const waiting = new Map<string, (reply: Reply) => void>();
	let pending = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		pending += chunk.toString("utf8");
		let end = pending.indexOf("\n");
		while (end >= 0) {
			const line = pending.slice(0, end).replace(/\r$/, "");
			pending = pending.slice(end + 1);
			end = pending.indexOf("\n");
			const record = recordOf(line);
			if (record?.type === "response" && typeof record.id === "string")
				waiting.get(record.id)?.({
					success: record.success === true,
					...(typeof record.error === "string" ? { error: record.error } : {}),
					data: record.data,
				});
		}
	});
	return (id) =>
		new Promise<Reply>((settle, fail) => {
			const timer = setTimeout(
				() => fail(new Error(`pi didn't answer ${id} in ${ANSWER_WAIT_MS} ms`)),
				ANSWER_WAIT_MS,
			);
			const ended = () => {
				clearTimeout(timer);
				fail(new Error(`pi ended before it answered ${id}`));
			};
			child.once("exit", ended);
			waiting.set(id, (reply) => {
				clearTimeout(timer);
				child.off("exit", ended);
				waiting.delete(id);
				settle(reply);
			});
		});
}

/** An RPC line as a record, or nothing when it isn't one. */
function recordOf(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return isRecord(value) ? value : undefined;
	} catch {
		// A line that isn't JSON isn't a reply pi gives.
		return undefined;
	}
}
