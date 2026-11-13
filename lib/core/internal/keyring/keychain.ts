/**
 * The macOS Keychain, through Apple's own `/usr/bin/security`.
 *
 * `security` rather than a native module, because the Keychain trusts
 * the program that made an item: an item node made trusts that node
 * binary, and every rebuild of node would ask the person again.
 * `security` is Apple's and stays put, so its items open without a
 * prompt once the login keychain is unlocked.
 *
 * A secret never rides on a command line, where any process could
 * read it: it goes in on stdin through `security -i`, encoded base64 so
 * nothing needs quoting. `security -i` reads lines of at most 4096
 * bytes, so a value longer than one chunk is kept as several items
 * under a generation, with the account's own item written last as a
 * header naming them. A reader therefore sees the old generation or
 * the new one whole, never a mix.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	KEYRING_SERVICE,
	KeyringUnavailable,
	reasonOf,
	type SecretStore,
} from "./store.ts";

/** What one run of `security` said. */
export interface SecurityResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Runs `security` with `args`, feeding it `input` on stdin. */
export type SecurityRunner = (
	args: readonly string[],
	input?: string,
) => Promise<SecurityResult>;

const NAME = "The Keychain";
const SECURITY = "/usr/bin/security";
/** `security`'s exit status for an item that isn't there. */
const ITEM_NOT_FOUND = 44;
/**
 * Base64 characters an item holds: with the command around it, a line
 * stays well under `security -i`'s 4096 bytes.
 */
export const CHUNK_LENGTH = 3000;
/** Long enough for a person to answer an unlock prompt. */
const SECURITY_TIMEOUT_MS = 60_000;
const WHOLE = "b64:";
const CHUNKED = "chunks:";

/** Runs the real `security`, saying plainly when it isn't there. */
const runSecurity: SecurityRunner = (args, input) =>
	new Promise((resolve, reject) => {
		const child = spawn(SECURITY, args, {
			stdio: ["pipe", "pipe", "pipe"],
			timeout: SECURITY_TIMEOUT_MS,
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
			resolve({
				code: code ?? (signal ? 1 : 0),
				stdout,
				stderr: signal ? `${stderr}security stopped by ${signal}` : stderr,
			});
		});
		child.stdin.end(input ?? "");
	});

/** Where a value's chunks are, from the header its account holds. */
interface Layout {
	readonly generation: string;
	readonly count: number;
}

function parseHeader(header: string): Layout | null {
	if (!header.startsWith(CHUNKED)) return null;
	const [generation, count] = header.slice(CHUNKED.length).split(":");
	const parsed = Number(count);
	if (!generation || !Number.isInteger(parsed) || parsed < 1) return null;
	return { generation, count: parsed };
}

function chunkAccount(account: string, generation: string, index: number) {
	return `${account}.${generation}.${index}`;
}

function addLine(account: string, password: string): string {
	return `add-generic-password -U -s ${KEYRING_SERVICE} -a ${account} -l "${KEYRING_SERVICE} ${account}" -w ${password}`;
}

/** The Keychain as a store, running `security` through `run`. */
export function keychainStore(run: SecurityRunner = runSecurity): SecretStore {
	async function security(
		args: readonly string[],
		input?: string,
	): Promise<SecurityResult> {
		try {
			return await run(args, input);
		} catch (error) {
			throw new KeyringUnavailable(NAME, `${SECURITY}: ${reasonOf(error)}`);
		}
	}

	function refuse(result: SecurityResult): never {
		const said = result.stderr.trim() || `security exited ${result.code}`;
		throw new KeyringUnavailable(NAME, said);
	}

	async function readItem(account: string): Promise<string | null> {
		const result = await security([
			"find-generic-password",
			"-s",
			KEYRING_SERVICE,
			"-a",
			account,
			"-w",
		]);
		if (result.code === ITEM_NOT_FOUND) return null;
		if (result.code !== 0) refuse(result);
		return result.stdout.replace(/\n$/, "");
	}

	async function deleteItem(account: string): Promise<void> {
		const result = await security([
			"delete-generic-password",
			"-s",
			KEYRING_SERVICE,
			"-a",
			account,
		]);
		if (result.code !== 0 && result.code !== ITEM_NOT_FOUND) refuse(result);
	}

	async function deleteChunks(account: string, layout: Layout | null) {
		if (!layout) return;
		for (let index = 0; index < layout.count; index++) {
			await deleteItem(chunkAccount(account, layout.generation, index));
		}
	}

	async function readEncoded(account: string): Promise<string | null> {
		const header = await readItem(account);
		if (header === null) return null;
		if (header.startsWith(WHOLE)) return header.slice(WHOLE.length);
		const layout = parseHeader(header);
		if (!layout) {
			throw new KeyringUnavailable(NAME, `${account} holds no value it wrote`);
		}
		let encoded = "";
		for (let index = 0; index < layout.count; index++) {
			const chunk = await readItem(
				chunkAccount(account, layout.generation, index),
			);
			if (chunk === null) {
				throw new KeyringUnavailable(NAME, `${account} is missing a chunk`);
			}
			encoded += chunk;
		}
		return encoded;
	}

	async function write(account: string, value: string): Promise<void> {
		const previous = await readItem(account);
		const encoded = Buffer.from(value, "utf-8").toString("base64");
		const lines: string[] = [];
		let generation: string | undefined;
		if (encoded.length <= CHUNK_LENGTH) {
			lines.push(addLine(account, `${WHOLE}${encoded}`));
		} else {
			generation = randomBytes(4).toString("hex");
			const count = Math.ceil(encoded.length / CHUNK_LENGTH);
			for (let index = 0; index < count; index++) {
				const piece = encoded.slice(
					index * CHUNK_LENGTH,
					(index + 1) * CHUNK_LENGTH,
				);
				lines.push(addLine(chunkAccount(account, generation, index), piece));
			}
			lines.push(addLine(account, `${CHUNKED}${generation}:${count}`));
		}
		const result = await security(["-i"], `${lines.join("\n")}\n`);
		if (result.code !== 0) refuse(result);
		// `security -i` carries on past a failed line, so only reading the
		// value back shows it was kept.
		const kept = await readEncoded(account);
		if (kept !== encoded) {
			throw new KeyringUnavailable(
				NAME,
				result.stderr.trim() || "it did not keep what was written",
			);
		}
		const old = previous === null ? null : parseHeader(previous);
		if (old && old.generation !== generation) await deleteChunks(account, old);
	}

	return {
		name: NAME,
		async read(account) {
			const encoded = await readEncoded(account);
			return encoded === null
				? null
				: Buffer.from(encoded, "base64").toString("utf-8");
		},
		write,
		async remove(account) {
			const header = await readItem(account);
			if (header === null) return;
			await deleteChunks(account, parseHeader(header));
			await deleteItem(account);
		},
	};
}
