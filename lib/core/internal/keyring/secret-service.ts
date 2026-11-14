/**
 * The Secret Service keyring (gnome-keyring, KWallet, KeePassXC), through
 * `@napi-rs/keyring`.
 *
 * The module speaks the Secret Service's D-Bus protocol itself, with
 * libdbus linked in, so nothing else needs installing: `secret-tool`
 * is missing from most desktops. Every entry is pinned to the Secret
 * Service, since the module would otherwise fall back to the kernel's
 * keyring when no Secret Service answers, which keeps secrets in
 * memory and loses them on the next boot; a missing Secret Service is
 * said, never papered over.
 *
 * A locked collection asks the person to unlock it, as the desktop's
 * own prompt; the async calls run off the event loop, so pi stays live
 * while it waits.
 */

import {
	KEYRING_SERVICE,
	KeyringUnavailable,
	reasonOf,
	type SecretStore,
} from "./store.ts";

/** The part of the module's AsyncEntry this store uses. */
export interface KeyringEntry {
	getPassword(): Promise<string | null | undefined>;
	setPassword(password: string): Promise<void>;
	deleteCredential(): Promise<boolean>;
}

/** Opens the entry for one account under the harness's service. */
export type EntryOpener = (account: string) => Promise<KeyringEntry>;

const NAME = "The Secret Service keyring";

/**
 * The module loads on first use rather than at import: its binary is
 * native, and one that won't load on this machine must cost a plain
 * message on the credentials it guards, not the extension that imports
 * this file.
 */
async function openNativeEntry(account: string): Promise<KeyringEntry> {
	const { AsyncEntry } = await import("@napi-rs/keyring");
	return new AsyncEntry(KEYRING_SERVICE, account, {
		linux: { store: "secret-service" },
	});
}

/** The Secret Service as a store, opening entries with `open`. */
export function secretServiceStore(
	open: EntryOpener = openNativeEntry,
): SecretStore {
	async function attempt<T>(
		account: string,
		act: (entry: KeyringEntry) => Promise<T>,
	): Promise<T> {
		try {
			return await act(await open(account));
		} catch (error) {
			throw new KeyringUnavailable(NAME, reasonOf(error));
		}
	}

	return {
		name: NAME,
		read: (account) =>
			attempt(account, async (entry) => (await entry.getPassword()) ?? null),
		write: (account, value) =>
			attempt(account, (entry) => entry.setPassword(value)),
		remove: (account) =>
			attempt(account, async (entry) => {
				await entry.deleteCredential();
			}),
	};
}
