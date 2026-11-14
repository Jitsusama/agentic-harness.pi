/**
 * Where the Slack credentials are kept: the desktop's keyring, as one
 * document.
 *
 * Provides shared read/write primitives used by credentials and OAuth
 * app modules. The plain file paths.ts names is where they lived
 * before; the first read moves it into the keyring, and it is used
 * again only while the keyring can't be reached, as
 * `lib/core/internal/keyring/document.ts` says.
 */

import { credentialsDocument } from "../../core/internal/keyring/document.ts";
import { credentialsPath } from "../paths.ts";
import type { OAuthApp, StoredToken } from "../types.ts";

/** Shape of the stored credentials. */
export interface CredentialsFile {
	oauthApp?: OAuthApp | null;
	token?: StoredToken | null;
}

const document = credentialsDocument<CredentialsFile>({
	account: "slack-credentials",
	label: "Slack credentials",
	filePath: credentialsPath,
	empty: () => ({}),
});

/** Read the stored credentials, or none when nothing is stored. */
export async function readCredentials(): Promise<CredentialsFile> {
	return document.read();
}

/** Write the credentials whole. */
export async function writeCredentials(data: CredentialsFile): Promise<void> {
	await document.write(data);
}

/** Move the plain file into the keyring now, if one is left. */
export async function moveToKeyring(): Promise<void> {
	await document.moveIfPresent();
}
