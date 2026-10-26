/**
 * Cookie key management: derive, cache, and validate the Chrome
 * cookie decryption key.
 *
 * Chrome marks each encrypted cookie with the key that sealed it.
 * On macOS every cookie is v10, sealed with a key derived from the
 * Keychain's password, so a one-time setupChromeKey() call reads it
 * and caches the derived AES key. On Linux, v10 cookies use the
 * built-in password "peanuts", and v11 cookies use a password Chrome
 * keeps in the desktop keyring (the Secret Service), which the same
 * one-time setup reads with secret-tool and caches.
 */

import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Where the cached decryption key lives.
 *
 * Adapter-neutral rather than scoped under any one host's own
 * config directory: the Keychain prompt this key is cached to avoid
 * is the same prompt for every adapter driving Chrome on this
 * machine, and re-deriving it per adapter would ask the user to
 * approve it once per host instead of once per machine.
 */
const CACHED_KEY_PATH = path.join(
	os.homedir(),
	".config",
	"agentic-harness",
	"chrome-cookie-key",
);

/**
 * Keychain or keyring query timeout in milliseconds. Long enough for
 * a person to answer an unlock prompt.
 */
const KEYCHAIN_TIMEOUT = 30000;

/** The keys that open each version of encrypted cookie. */
export interface CookieKeys {
	v10: Buffer | null;
	v11: Buffer | null;
}

/**
 * Thrown on Linux when Chrome sealed cookies with the keyring's key
 * and setup has not read it yet.
 */
export class KeyringSetupNeeded extends Error {
	constructor() {
		super(
			"Chrome keeps its cookie key in the desktop keyring here, and it " +
				"has not been read yet. Ask the user to run Chrome cookie setup, " +
				"which reads it with secret-tool (from libsecret).",
		);
		this.name = "KeyringSetupNeeded";
	}
}

/**
 * Thrown when the cached key exists but can't decrypt any cookies,
 * indicating Chrome was reinstalled and the key is stale.
 */
export class StaleKeyError extends Error {
	constructor() {
		super(
			"Chrome cookie decryption key appears stale (Chrome may have " +
				"been reinstalled). Ask the user to redo Chrome cookie setup " +
				"to regenerate it.",
		);
		this.name = "StaleKeyError";
	}
}

function deriveKey(password: string, iterations: number): Buffer {
	return crypto.pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
}

/**
 * The keys for each cookie version, null where setup has not cached
 * one. On Linux the v10 key needs no setup.
 */
export function getDecryptionKeys(): CookieKeys {
	const cached = readCachedKey();
	if (process.platform === "darwin") return { v10: cached, v11: cached };
	return { v10: deriveKey("peanuts", 1), v11: cached };
}

function readCachedKey(): Buffer | null {
	try {
		const encoded = fs.readFileSync(CACHED_KEY_PATH, "utf-8").trim();
		if (!encoded) return null;
		return Buffer.from(encoded, "base64");
	} catch {
		/* Cached key file missing or unreadable: not set up */
		return null;
	}
}

/**
 * The command that prints Chrome's Safe Storage password: the
 * Keychain on macOS, the Secret Service keyring elsewhere.
 */
function passwordCommand(): string {
	if (process.platform === "darwin") {
		return "security find-generic-password -s 'Chrome Safe Storage' -a 'Chrome' -w";
	}
	return "secret-tool lookup application chrome";
}

/**
 * One-time setup: derive the Chrome cookie decryption key from the
 * macOS Keychain or the Linux keyring and cache it. This is the only
 * operation that can raise an unlock prompt.
 *
 * Returns true on success, false on failure: the prompt was denied,
 * the keyring holds no Chrome password, or on Linux secret-tool is
 * not installed.
 */
export function setupChromeKey(): boolean {
	try {
		const password = execSync(passwordCommand(), {
			encoding: "utf-8",
			timeout: KEYCHAIN_TIMEOUT,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (!password) return false;

		const key = deriveKey(password, process.platform === "darwin" ? 1003 : 1);
		const dir = path.dirname(CACHED_KEY_PATH);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(CACHED_KEY_PATH, key.toString("base64"), {
			mode: 0o600,
		});
		return true;
	} catch {
		/* Keychain denied, no keyring password, or write failed */
		return false;
	}
}

/**
 * Check whether cookies can be read without setup. On Linux they can
 * until a cookie turns out to need the keyring's key, which reading
 * reports as KeyringSetupNeeded.
 */
export function isSetUp(): boolean {
	if (process.platform !== "darwin") return true;
	return fs.existsSync(CACHED_KEY_PATH);
}

/** Check whether setup has cached a key, whatever the platform. */
export function hasCachedKey(): boolean {
	return fs.existsSync(CACHED_KEY_PATH);
}
