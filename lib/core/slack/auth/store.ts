/**
 * File-based persistence for Slack credentials.
 *
 * Provides shared read/write primitives used by credentials
 * and OAuth app modules. The credentials file's location is
 * decided by paths.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { credentialsPath } from "../paths.ts";
import type { OAuthApp, StoredToken } from "../types.ts";

/** Shape of the persisted credentials file. */
export interface CredentialsFile {
	oauthApp?: OAuthApp | null;
	token?: StoredToken | null;
}

/** Read the credentials file, returning defaults if missing or corrupt. */
export function readFile(
	filePath: string = credentialsPath(),
): CredentialsFile {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as CredentialsFile;
	} catch {
		// The file doesn't exist or is corrupt, so we start fresh.
		return {};
	}
}

/** Write the credentials file atomically. */
export function writeFile(
	data: CredentialsFile,
	filePath: string = credentialsPath(),
): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(data, null, "\t"), "utf-8");
}
