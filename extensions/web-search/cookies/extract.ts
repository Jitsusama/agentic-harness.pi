/**
 * Cookie extraction: reads encrypted cookies from the local
 * Chrome profile, decrypts them, and returns puppeteer-compatible
 * cookie objects.
 *
 * Handles __Host- prefix cookies and correct domain matching
 * per RFC 6265.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getDecryptionKey, isSetUp, StaleKeyError } from "./setup.js";

/** Microseconds between 1601-01-01 and 1970-01-01. */
const CHROME_EPOCH_OFFSET = 11644473600n * 1_000_000n;

/** Length of the SHA-256 hash prefix Chrome prepends to cookie values. */
const HASH_PREFIX_LENGTH = 32;

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
		/* Chrome data dir unreadable: no profile found */
	}
	return null;
}

function decrypt(encryptedValue: Buffer, key: Buffer): string | null {
	if (encryptedValue.length < 4) return null;

	const prefix = encryptedValue.slice(0, 3).toString("ascii");
	if (prefix !== "v10" && prefix !== "v11") {
		return encryptedValue.toString("utf-8");
	}

	const ciphertext = encryptedValue.slice(3);
	const iv = Buffer.alloc(16, 0x20);

	try {
		const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
		const decrypted = Buffer.concat([
			decipher.update(ciphertext),
			decipher.final(),
		]);
		if (decrypted.length > HASH_PREFIX_LENGTH) {
			return decrypted.slice(HASH_PREFIX_LENGTH).toString("utf-8");
		}
		return decrypted.toString("utf-8");
	} catch {
		/* Decryption failed: wrong key or corrupted value */
		return null;
	}
}

function cookieHostKeys(hostname: string): string[] {
	const keys = [hostname];
	const parts = hostname.split(".");
	for (let i = 0; i < parts.length - 1; i++) {
		keys.push(`.${parts.slice(i).join(".")}`);
	}
	return keys;
}

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
	for (const suffix of ["-wal", "-shm"]) {
		const src = dbPath + suffix;
		if (fs.existsSync(src)) {
			fs.copyFileSync(src, tmpDb + suffix);
		}
	}

	// We lazy-require sqlite3 because it's a native module and
	// we only want to load it when cookies are actually needed,
	// not on every extension load.
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
			for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
				try {
					fs.unlinkSync(f);
				} catch {
					/* temp file cleanup: safe to ignore */
				}
			}
			if (err) reject(err);
			else resolve(rows || []);
		});
	});
}

const SAMESITE_MAP: Record<number, "Strict" | "Lax" | "None" | undefined> = {
	[-1]: undefined,
	0: "None",
	1: "Lax",
	2: "Strict",
};

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

	if (cookies.length === 0 && decryptFailures > 0 && isSetUp()) {
		throw new StaleKeyError();
	}

	return cookies;
}
