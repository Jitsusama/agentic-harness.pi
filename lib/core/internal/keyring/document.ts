/**
 * A credentials document kept in the keyring, with the plain file it
 * used to live in as the fallback and the source of a one-time move.
 *
 * The keyring holds the whole document as JSON, one item a document.
 * A plain file that still exists is newer than anything the keyring
 * holds, since only a keyring that couldn't be reached leaves one
 * written, so a read that finds one moves it: write it to the keyring,
 * read it back, and remove the file only once the two agree. The move
 * runs under the file's lock, since every session on the machine may
 * start at once and read together.
 *
 * When the keyring can't be reached, the document reads and writes the
 * file as before, so signing in and refreshing keep working, and says
 * so through a notice naming the cause and the file. Nothing falls back
 * without saying.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { withFileLock } from "../file-lock.ts";
import { sayKeyringNotice } from "./notices.ts";
import { secretStore } from "./secrets.ts";
import { KeyringUnavailable, type SecretStore } from "./store.ts";

/** What a document is and where its plain file was. */
export interface DocumentSpec<T> {
	/** The keyring item's account, such as `google-credentials`. */
	readonly account: string;
	/** What the person calls it in a notice: "Google credentials". */
	readonly label: string;
	/** Where the plain file lives, or lived. */
	readonly filePath: () => string;
	/** The document when nothing is stored yet; a fresh value each call. */
	readonly empty: () => T;
	/** The store to keep it in; the platform's unless a test says. */
	readonly store?: () => SecretStore;
}

/** A document read and written whole. */
export interface CredentialsDocument<T> {
	read(): Promise<T>;
	write(data: T): Promise<void>;
	/** Move the plain file into the keyring now, if there is one. */
	moveIfPresent(): Promise<void>;
}

/** A document kept as `spec` says. */
export function credentialsDocument<T>(
	spec: DocumentSpec<T>,
): CredentialsDocument<T> {
	const storeOf = spec.store ?? secretStore;

	function sayUnreachable(error: KeyringUnavailable, file: string): void {
		sayKeyringNotice({
			level: "warning",
			message:
				`${error.message}. ${spec.label} stay in the plain file ${file} ` +
				"until it can; they move on the next read once it answers.",
		});
	}

	function readPlainFile(file: string): T | null {
		let raw: string;
		try {
			raw = fs.readFileSync(file, "utf-8");
		} catch {
			// No file is the common case once the move is done.
			return null;
		}
		try {
			return JSON.parse(raw) as T;
		} catch {
			sayKeyringNotice({
				level: "warning",
				message: `${spec.label} in ${file} aren't valid JSON, so they read as empty; the file is left as it is.`,
			});
			return null;
		}
	}

	function writePlainFile(file: string, data: T): void {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(data, null, "\t"), {
			encoding: "utf-8",
			mode: 0o600,
		});
		// The mode above applies only to a file it creates; one from before
		// may be readable by others.
		fs.chmodSync(file, 0o600);
	}

	function removePlainFile(file: string): void {
		fs.rmSync(file, { force: true });
	}

	/** Write `data` to the keyring and say whether it reads back the same. */
	async function keep(store: SecretStore, data: T): Promise<boolean> {
		const serialized = JSON.stringify(data);
		await store.write(spec.account, serialized);
		return (await store.read(spec.account)) === serialized;
	}

	async function readKeyring(store: SecretStore): Promise<T> {
		const raw = await store.read(spec.account);
		if (raw === null) return spec.empty();
		try {
			return JSON.parse(raw) as T;
		} catch {
			sayKeyringNotice({
				level: "warning",
				message: `${spec.label} in ${store.name} aren't valid JSON, so they read as empty; signing in again replaces them.`,
			});
			return spec.empty();
		}
	}

	/** Move the file into the keyring, answering what the document holds. */
	async function move(store: SecretStore, file: string): Promise<T> {
		return withFileLock(file, async () => {
			const fromFile = readPlainFile(file);
			// Another session moved it while this one waited for the lock.
			if (fromFile === null) return readKeyring(store);
			if (!(await keep(store, fromFile))) {
				sayKeyringNotice({
					level: "warning",
					message: `${store.name} did not give back the ${spec.label} written to it, so they stay in the plain file ${file}.`,
				});
				return fromFile;
			}
			removePlainFile(file);
			sayKeyringNotice({
				level: "info",
				message: `${spec.label} moved into ${store.name}; the plain file ${file} is gone.`,
			});
			return fromFile;
		});
	}

	async function read(): Promise<T> {
		const file = spec.filePath();
		const store = storeOf();
		try {
			if (fs.existsSync(file)) return await move(store, file);
			return await readKeyring(store);
		} catch (error) {
			if (!(error instanceof KeyringUnavailable)) throw error;
			sayUnreachable(error, file);
			return readPlainFile(file) ?? spec.empty();
		}
	}

	async function write(data: T): Promise<void> {
		const file = spec.filePath();
		const store = storeOf();
		try {
			if (!(await keep(store, data))) {
				throw new KeyringUnavailable(
					store.name,
					"it did not give back what was written",
				);
			}
			// A file left by an earlier fallback is now older than the
			// keyring, and a read would take it for the newer.
			removePlainFile(file);
		} catch (error) {
			if (!(error instanceof KeyringUnavailable)) throw error;
			sayUnreachable(error, file);
			writePlainFile(file, data);
		}
	}

	return {
		read,
		write,
		async moveIfPresent() {
			if (fs.existsSync(spec.filePath())) await read();
		},
	};
}
