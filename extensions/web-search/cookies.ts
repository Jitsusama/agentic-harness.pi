/**
 * Chrome cookie extraction — reads encrypted cookies from the local
 * Chrome profile and decrypts them for use with puppeteer.
 *
 * On macOS, requires a one-time setup step (setupChromeKey) that
 * derives the AES key from Chrome's Keychain password and caches it
 * to ~/.config/pi/chrome-cookie-key. This keeps the Keychain prompt
 * explicit and user-initiated rather than surprising.
 *
 * On Linux, the default password is hardcoded ("peanuts") so no
 * setup is needed.
 *
 * Handles __Host- prefix cookies and correct domain matching per
 * RFC 6265.
 */

import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Microseconds between 1601-01-01 and 1970-01-01. */
const CHROME_EPOCH_OFFSET = 11644473600n * 1_000_000n;

/** Length of the SHA-256 hash prefix Chrome prepends to cookie values. */
const HASH_PREFIX_LENGTH = 32;

/** Where the cached decryption key lives. */
const CACHED_KEY_PATH = path.join(
	os.homedir(),
	".config",
	"pi",
	"chrome-cookie-key",
);

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

/** Cookie in puppeteer-compatible format. */
export interface PuppeteerCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	expires: number;
	httpOnly: boolean;
	secure: boolean;
	sameSite?: "Strict" | "Lax" | "None";
}

// ── Chrome profile detection ──────────────────────────────────────

function chromeDataDir(): string {
	if (process.platform === "darwin") {
		return path.join(
			os.homedir(),
			"Library",
			"Application Support",
			"Google",
			"Chrome",
		);
	}
	return path.join(os.homedir(), ".config", "google-chrome");
}

function findCookiesDb(): string | null {
	const base = chromeDataDir();
	// Try Default first, then numbered profiles
	const defaultDb = path.join(base, "Default", "Cookies");
	if (fs.existsSync(defaultDb)) return defaultDb;

	try {
		const entries = fs.readdirSync(base).sort();
		for (const entry of entries) {
			if (entry.startsWith("Profile ")) {
				const db = path.join(base, entry, "Cookies");
				if (fs.existsSync(db)) return db;
			}
		}
	} catch {
		// Can't read Chrome dir
	}
	return null;
}

// ── Key management ────────────────────────────────────────────────

function deriveKey(password: string, iterations: number): Buffer {
	return crypto.pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
}

/**
 * Read the cached decryption key. Returns null if the key hasn't
 * been set up yet (on macOS) or derives it directly (on Linux).
 */
function getDecryptionKey(): Buffer | null {
	if (process.platform !== "darwin") {
		// Linux: default password is "peanuts", 1 iteration
		return deriveKey("peanuts", 1);
	}

	// macOS: read from cache
	try {
		const encoded = fs.readFileSync(CACHED_KEY_PATH, "utf-8").trim();
		if (!encoded) return null;
		return Buffer.from(encoded, "base64");
	} catch {
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
			{ encoding: "utf-8", timeout: 30000 },
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
		return false;
	}
}

/** Check whether the cached key exists (setup has been done). */
export function isSetUp(): boolean {
	if (process.platform !== "darwin") return true;
	return fs.existsSync(CACHED_KEY_PATH);
}

// ── Decryption ────────────────────────────────────────────────────

function decrypt(encryptedValue: Buffer, key: Buffer): string | null {
	if (encryptedValue.length < 4) return null;

	// Check for v10/v11 prefix
	const prefix = encryptedValue.slice(0, 3).toString("ascii");
	if (prefix !== "v10" && prefix !== "v11") {
		// Might be unencrypted
		return encryptedValue.toString("utf-8");
	}

	const ciphertext = encryptedValue.slice(3);
	const iv = Buffer.alloc(16, 0x20); // 16 bytes of space (0x20)

	try {
		const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
		const decrypted = Buffer.concat([
			decipher.update(ciphertext),
			decipher.final(),
		]);
		// Chrome prepends a 32-byte SHA-256 hash to cookie values;
		// strip it to get the actual value.
		if (decrypted.length > HASH_PREFIX_LENGTH) {
			return decrypted.slice(HASH_PREFIX_LENGTH).toString("utf-8");
		}
		return decrypted.toString("utf-8");
	} catch {
		return null;
	}
}

// ── Domain matching (RFC 6265) ────────────────────────────────────

/**
 * Build the list of host_key values that could hold cookies
 * applicable to the given hostname. Includes:
 *   - exact host (for host-only cookies like __Host- prefixed)
 *   - dot-prefixed domain and parent domains
 */
function cookieHostKeys(hostname: string): string[] {
	const keys = [hostname]; // exact match for host-only cookies
	const parts = hostname.split(".");
	// Walk up from full domain: a.b.c → .a.b.c, .b.c, .c
	// (skip single-label TLDs)
	for (let i = 0; i < parts.length - 1; i++) {
		keys.push(`.${parts.slice(i).join(".")}`);
	}
	return keys;
}

// ── SQLite query ──────────────────────────────────────────────────

/**
 * Copy the Cookies DB to a temp location to avoid WAL lock conflicts
 * with a running Chrome, then query it.
 */
interface CookieRow {
	name: string;
	encrypted_value: Buffer;
	host_key: string;
	path: string;
	expires_utc: bigint;
	is_secure: number;
	is_httponly: number;
	samesite: number;
}

function queryCookies(
	dbPath: string,
	hostKeys: string[],
): Promise<CookieRow[]> {
	const tmpDb = path.join(os.tmpdir(), `pi-chrome-cookies-${Date.now()}.db`);
	fs.copyFileSync(dbPath, tmpDb);
	// Also copy WAL and SHM if they exist
	for (const suffix of ["-wal", "-shm"]) {
		const src = dbPath + suffix;
		if (fs.existsSync(src)) {
			fs.copyFileSync(src, tmpDb + suffix);
		}
	}

	const sqlite3 = require("sqlite3");
	const db = new sqlite3.Database(tmpDb, sqlite3.OPEN_READONLY);

	const placeholders = hostKeys.map(() => "?").join(", ");
	const sql = `
		SELECT name, encrypted_value, host_key, path,
		       expires_utc, is_secure, is_httponly, samesite
		FROM cookies
		WHERE host_key IN (${placeholders})
	`;

	return new Promise((resolve, reject) => {
		db.all(sql, hostKeys, (err: Error | null, rows: CookieRow[]) => {
			db.close();
			// Clean up temp files
			for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
				try {
					fs.unlinkSync(f);
				} catch {
					/* ignore */
				}
			}
			if (err) reject(err);
			else resolve(rows || []);
		});
	});
}

// ── samesite mapping ──────────────────────────────────────────────

const SAMESITE_MAP: Record<number, "Strict" | "Lax" | "None" | undefined> = {
	[-1]: undefined, // unspecified
	0: "None",
	1: "Lax",
	2: "Strict",
};

// ── Public API ────────────────────────────────────────────────────

/**
 * Read Chrome cookies for a URL, decrypt them, and return in
 * puppeteer-compatible format. Returns an empty array if the key
 * hasn't been set up, the profile can't be found, or decryption
 * fails.
 */
export async function getCookiesForUrl(
	url: string,
): Promise<PuppeteerCookie[]> {
	const dbPath = findCookiesDb();
	if (!dbPath) return [];

	const key = getDecryptionKey();
	if (!key) return [];

	const parsed = new URL(url);
	const hostKeys = cookieHostKeys(parsed.hostname);

	const rows = await queryCookies(dbPath, hostKeys);
	if (rows.length === 0) return [];

	let decryptFailures = 0;
	const cookies: PuppeteerCookie[] = [];
	for (const row of rows) {
		const value = decrypt(row.encrypted_value, key);
		if (value === null) {
			decryptFailures++;
			continue;
		}

		// Convert Chrome epoch (microseconds since 1601) to Unix seconds
		const expiresUtc = BigInt(row.expires_utc);
		const expires =
			expiresUtc === 0n
				? -1
				: Number((expiresUtc - CHROME_EPOCH_OFFSET) / 1_000_000n);

		cookies.push({
			name: row.name,
			value,
			domain: row.host_key,
			path: row.path,
			expires,
			httpOnly: row.is_httponly === 1,
			secure: row.is_secure === 1,
			sameSite: SAMESITE_MAP[row.samesite],
		});
	}

	// If every cookie failed to decrypt and we have a cached key,
	// the key is almost certainly stale (Chrome was reinstalled).
	if (cookies.length === 0 && decryptFailures > 0 && isSetUp()) {
		throw new StaleKeyError();
	}

	return cookies;
}
