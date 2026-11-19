/**
 * The Secret Service keyring (gnome-keyring, KWallet, KeePassXC), through
 * `@napi-rs/keyring`.
 *
 * The module speaks the Secret Service's D-Bus protocol itself, with
 * libdbus linked in, so nothing else needs installing: `secret-tool`
 * is missing from most desktops. Each call runs it in a node process of
 * its own (secret-service-call.mjs), never in pi's: on 18 November the
 * module crashed with SIGSEGV inside its entry constructor and took the
 * work background host, and every conversation it held, down with it.
 * A crash there now fails one call. Every entry is pinned to the Secret
 * Service, since the module would otherwise fall back to the kernel's
 * keyring when no Secret Service answers, which keeps secrets in
 * memory and loses them on the next boot; a missing Secret Service is
 * said, never papered over.
 *
 * A locked collection asks the person to unlock it, as the desktop's
 * own prompt; the call's process waits on it, so pi stays live
 * meanwhile. No call has a deadline, as before: giving up on a prompt
 * nobody has answered yet would put the credentials in the plain file
 * (document.ts) instead.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	KEYRING_SERVICE,
	KeyringUnavailable,
	reasonOf,
	type SecretStore,
} from "./store.ts";

/** The part of the module's AsyncEntry this store uses. */
export interface KeyringEntry {
	getPassword(): Promise<string | null | undefined>;
	setPassword(password: string): Promise<void>;
	deleteCredential(): Promise<boolean>;
}

/** Opens the entry for one account under the harness's service. */
export type EntryOpener = (account: string) => Promise<KeyringEntry>;

const NAME = "The Secret Service keyring";
/**
 * The most calls that run at once: a host resuming 84 conversations
 * could otherwise start a node for each in the same second.
 */
const CALLS_AT_ONCE = 4;
/** The program that makes one call, beside this file. */
const CALL_SCRIPT = fileURLToPath(
	new URL("./secret-service-call.mjs", import.meta.url),
);

/** What one call asks of secret-service-call.mjs. */
interface Asked {
	readonly account: string;
	readonly act: "read" | "write" | "remove";
	readonly value?: string;
}

/** What it answered, from its one line of JSON. */
interface Answered {
	readonly value?: string | null;
	readonly error?: string;
}

function isAnswered(parsed: unknown): parsed is Answered {
	return typeof parsed === "object" && parsed !== null;
}

/** What one line of the call's stdout says, or why it says nothing usable. */
function answerIn(line: string): Answered | Error {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return new Error("its keyring call answered nothing readable");
	}
	if (!isAnswered(parsed)) {
		return new Error("its keyring call answered nothing readable");
	}
	return typeof parsed.error === "string" ? new Error(parsed.error) : parsed;
}

/** The longest reason kept from what a call left on stderr. */
const REASON_LENGTH = 300;

/**
 * What a call left on stderr, said as one line and cut short: the
 * first line that heads an error, `TypeError: …`, `Error [CODE]: …` or
 * node's own `FATAL ERROR: …`, as node's report puts one under its
 * source line and above its stack; else a Rust panic's message with
 * where it panicked, as the native module would leave one, however its
 * Rust names the thread; else all of it, joined.
 */
export function whatWentWrong(stderr: string): string | undefined {
	const lines = stderr
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return cut(
		lines.find((line) => /^(\w*Error( \[\w+\])?|FATAL ERROR): /.test(line)) ??
			panicked(lines) ??
			lines.join(" / "),
	);
}

/** A Rust panic's message and where it panicked, if `lines` hold one. */
function panicked(lines: string[]): string | undefined {
	const at = lines.findIndex((line) => /^thread .* panicked at /.test(line));
	if (at < 0) return undefined;
	const where = (lines[at] ?? "").replace(/^.* panicked at (.*?):?$/, "$1");
	const message = lines[at + 1];
	return message && !message.startsWith("note: ")
		? `${message} (panicked at ${where})`
		: `panicked at ${where}`;
}

/** `reason` cut to REASON_LENGTH, or nothing when it says nothing. */
function cut(reason: string): string | undefined {
	if (!reason) return undefined;
	return reason.length > REASON_LENGTH
		? `${reason.slice(0, REASON_LENGTH)}…`
		: reason;
}

/**
 * Runs `script` with `node` for one call, the call going in on stdin so
 * a value never rides on a command line. Settles on the first full line
 * it answers, ending the process if it lingers, since the call is done
 * by then. Rejects with why when the call failed, its process could not
 * start or stopped by a signal before answering, or it said nothing
 * readable.
 */
function callOnce(
	node: string,
	script: string,
	asked: Asked,
): Promise<Answered> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const child = spawn(node, [script], { stdio: ["pipe", "pipe", "pipe"] });
		function settle(outcome: Answered | Error): void {
			if (settled) return;
			settled = true;
			if (outcome instanceof Error) reject(outcome);
			else resolve(outcome);
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
			}
		}
		child.on("error", (error) => settle(error));
		child.stdin.on("error", (error) => settle(error));
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf-8");
		child.stderr.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			const end = stdout.indexOf("\n");
			if (end >= 0) settle(answerIn(stdout.slice(0, end)));
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("close", (code, signal) => {
			const said = whatWentWrong(stderr);
			if (signal) {
				settle(
					new Error(
						`its keyring call stopped by ${signal}${said ? `: ${said}` : ""}`,
					),
				);
			} else if (stdout.trim()) {
				settle(answerIn(stdout.trim()));
			} else {
				settle(new Error(said || `its keyring call exited ${code}`));
			}
		});
		child.stdin.end(JSON.stringify({ service: KEYRING_SERVICE, ...asked }));
	});
}

/**
 * Runs work at most `at` at once, the rest waiting their turn in the
 * order they came. A finished call hands its place straight to the next
 * waiting, so a newcomer can't slip in between.
 */
function limited(at: number) {
	let running = 0;
	const waiting: (() => void)[] = [];
	return async <T>(work: () => Promise<T>): Promise<T> => {
		if (running < at) running++;
		else await new Promise<void>((go) => waiting.push(go));
		try {
			return await work();
		} finally {
			const next = waiting.shift();
			if (next) next();
			else running--;
		}
	};
}

/**
 * Opens entries whose every call runs `script` with `node` in a process
 * of its own, the real call by default, at most {@link CALLS_AT_ONCE} at
 * once. Reads of one account asked while one is already under way share
 * its answer, or its failure, rather than starting another process.
 * Nothing is kept once it ends, so a write elsewhere is read the next
 * time. A write or remove here stops any read under way being shared,
 * as it starts and again as it ends, so a read asked after it, its own
 * read-back included, never takes an answer from before it.
 */
export function callingEntries(
	script: string = CALL_SCRIPT,
	node: string = process.execPath,
): EntryOpener {
	const turn = limited(CALLS_AT_ONCE);
	const reading = new Map<string, Promise<Answered>>();
	const call = (asked: Asked) => turn(() => callOnce(node, script, asked));

	function read(account: string): Promise<Answered> {
		const under = reading.get(account);
		if (under) return under;
		const started = call({ account, act: "read" }).finally(() => {
			if (reading.get(account) === started) reading.delete(account);
		});
		reading.set(account, started);
		return started;
	}

	async function changing(account: string, asked: Asked): Promise<void> {
		reading.delete(account);
		try {
			await call(asked);
		} finally {
			reading.delete(account);
		}
	}

	return async (account) => ({
		async getPassword() {
			return (await read(account)).value ?? null;
		},
		async setPassword(password) {
			await changing(account, { account, act: "write", value: password });
		},
		async deleteCredential() {
			await changing(account, { account, act: "remove" });
			return true;
		},
	});
}

/** The Secret Service as a store, opening entries with `open`. */
export function secretServiceStore(
	open: EntryOpener = callingEntries(),
): SecretStore {
	async function attempt<T>(
		account: string,
		act: (entry: KeyringEntry) => Promise<T>,
	): Promise<T> {
		try {
			return await act(await open(account));
		} catch (error) {
			throw new KeyringUnavailable(NAME, reasonOf(error));
		}
	}

	return {
		name: NAME,
		read: (account) =>
			attempt(account, async (entry) => (await entry.getPassword()) ?? null),
		write: (account, value) =>
			attempt(account, (entry) => entry.setPassword(value)),
		remove: (account) =>
			attempt(account, async (entry) => {
				await entry.deleteCredential();
			}),
	};
}
