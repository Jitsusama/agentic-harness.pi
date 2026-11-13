/**
 * Where the Google Workspace credentials are kept: the desktop's
 * keyring, as one document.
 *
 * Provides the shared read/write primitives used by both
 * credentials.ts and oauth-app.ts. The plain file paths.ts names is
 * where they lived before; the first read moves it into the keyring,
 * and it is used again only while the keyring can't be reached, as
 * `lib/core/internal/keyring/document.ts` says.
 */

import { credentialsDocument } from "../../core/internal/keyring/document.ts";
import { credentialsPath } from "../paths.ts";
import type { GoogleAccount, StoredCredentials } from "../types.ts";
import type { OAuthAppCredentials } from "./oauth-app.ts";

/** Shape of the stored credentials. */
export interface CredentialsFile {
	oauthApp?: OAuthAppCredentials | null;
	accounts: GoogleAccount[];
	tokens: Record<string, StoredCredentials>;
}

const document = credentialsDocument<CredentialsFile>({
	account: "google-credentials",
	label: "Google Workspace credentials",
	filePath: credentialsPath,
	empty: () => ({ accounts: [], tokens: {} }),
});

/** Read the stored credentials, with defaults for what is missing. */
export async function readCredentials(): Promise<CredentialsFile> {
	const data = await document.read();
	return {
		...data,
		accounts: Array.isArray(data.accounts) ? data.accounts : [],
		tokens: data.tokens ?? {},
	};
}

/** Write the credentials whole. */
export async function writeCredentials(data: CredentialsFile): Promise<void> {
	await document.write(data);
}

/** Move the plain file into the keyring now, if one is left. */
export async function moveToKeyring(): Promise<void> {
	await document.moveIfPresent();
}
