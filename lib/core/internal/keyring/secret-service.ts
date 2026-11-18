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
 * meanwhile.
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
/** Long enough for a person to answer an unlock prompt. */
const CALL_TIMEOUT_MS = 60_000;
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

/**
 * Runs `script` with `node` for one call, the call going in on stdin so
 * a value never rides on a command line. Rejects with why when the call
 * failed, its process stopped by a signal, or it said nothing readable.
 */
function callOnce(
	node: string,
	script: string,
	asked: Asked,
): Promise<Answered> {
	return new Promise((resolve, reject) => {
		const child = spawn(node, [script], {
			stdio: ["pipe", "pipe", "pipe"],
			timeout: CALL_TIMEOUT_MS,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (signal) {
				reject(new Error(`its keyring call stopped by ${signal}`));
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(stdout);
			} catch {
				const said = stderr.trim() || `its keyring call exited ${code}`;
				reject(new Error(said));
				return;
			}
			if (!isAnswered(parsed)) {
				reject(new Error("its keyring call answered nothing readable"));
			} else if (typeof parsed.error === "string") {
				reject(new Error(parsed.error));
			} else {
				resolve(parsed);
			}
		});
		child.stdin.end(JSON.stringify({ service: KEYRING_SERVICE, ...asked }));
	});
}

/**
 * Opens entries whose every call runs `script` with `node` in a process
 * of its own; the real call by default.
 */
export function callingEntries(
	script: string = CALL_SCRIPT,
	node: string = process.execPath,
): EntryOpener {
	return async (account) => ({
		async getPassword() {
			const answered = await callOnce(node, script, { account, act: "read" });
			return answered.value ?? null;
		},
		async setPassword(password) {
			await callOnce(node, script, { account, act: "write", value: password });
		},
		async deleteCredential() {
			await callOnce(node, script, { account, act: "remove" });
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
