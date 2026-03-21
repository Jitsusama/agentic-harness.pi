/**
 * Cookie key management: derive, cache, and validate the Chrome
 * cookie decryption key.
 *
 * On macOS, requires a one-time setupChromeKey() call that reads
 * the password from the Keychain and caches the derived AES key.
 * On Linux, the default password is hardcoded ("peanuts").
 */

import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where the cached decryption key lives. */
const CACHED_KEY_PATH = path.join(
	os.homedir(),
	".config",
	"pi",
	"chrome-cookie-key",
);

/** Keychain query timeout in milliseconds. */
const KEYCHAIN_TIMEOUT = 30000;

/**
 * Thrown when the cached key exists but can't decrypt any cookies,
 * indicating Chrome was reinstalled and the key is stale.
 */
export class StaleKeyError extends Error {
	constructor() {
		super(
			"Chrome cookie decryption key appears stale (Chrome may have " +
				"been reinstalled). Ask the user to type the pi slash " +
				"command /setup-chrome-cookies --force to regenerate it.",
		);
		this.name = "StaleKeyError";
	}
}

function deriveKey(password: string, iterations: number): Buffer {
	return crypto.pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
}

/**
 * Read the cached decryption key. Returns null if the key hasn't
 * been set up yet (on macOS) or derives it directly (on Linux).
 */
export function getDecryptionKey(): Buffer | null {
	if (process.platform !== "darwin") {
		// Linux: default password is "peanuts", 1 iteration
		return deriveKey("peanuts", 1);
	}

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
 * One-time setup: derive the Chrome cookie decryption key from the
 * macOS Keychain and cache it. This is the only operation that
 * triggers a Keychain prompt.
 *
 * Returns true on success, false on failure. On Linux this is a
 * no-op that always succeeds (no setup needed).
 */
export function setupChromeKey(): boolean {
	if (process.platform !== "darwin") return true;

	try {
		const password = execSync(
			"security find-generic-password -s 'Chrome Safe Storage' -a 'Chrome' -w",
			{ encoding: "utf-8", timeout: KEYCHAIN_TIMEOUT },
		).trim();
		if (!password) return false;

		const key = deriveKey(password, 1003);
		const dir = path.dirname(CACHED_KEY_PATH);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(CACHED_KEY_PATH, key.toString("base64"), {
			mode: 0o600,
		});
		return true;
	} catch {
		/* Keychain denied or write failed: report as failure */
		return false;
	}
}

/** Check whether the cached key exists (setup has been done). */
export function isSetUp(): boolean {
	if (process.platform !== "darwin") return true;
	return fs.existsSync(CACHED_KEY_PATH);
}
