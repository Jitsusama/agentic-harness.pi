/**
 * File-based persistence for Google Workspace credentials.
 *
 * Provides the shared read/write primitives used by both
 * credentials.ts and oauth-app.ts. The credentials file
 * lives at ~/.pi/agent/google-workspace.json.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GoogleAccount, StoredCredentials } from "../types.js";
import type { OAuthAppCredentials } from "./oauth-app.js";

/** Path to the credentials file in Pi's global config directory. */
const CREDENTIALS_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"google-workspace.json",
);

/** Shape of the persisted credentials file. */
export interface CredentialsFile {
	oauthApp?: OAuthAppCredentials | null;
	accounts: GoogleAccount[];
	tokens: Record<string, StoredCredentials>;
}

/** Read the credentials file, returning defaults if missing or corrupt. */
export function readFile(filePath: string = CREDENTIALS_PATH): CredentialsFile {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as CredentialsFile;
	} catch {
		// The file doesn't exist or is corrupt, so we start fresh.
		return { accounts: [], tokens: {} };
	}
}

/** Write the credentials file atomically. */
export function writeFile(
	data: CredentialsFile,
	filePath: string = CREDENTIALS_PATH,
): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(data, null, "\t"), "utf-8");
}
