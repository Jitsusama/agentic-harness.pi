/**
 * What a secret store is, and the one error every store throws when it
 * can't be reached.
 *
 * Every item sits under one service, `agentic-harness`, named by an
 * account such as `google-credentials`. A store that cannot be reached
 * (no Secret Service, a locked or denied keyring, no `security`) throws
 * KeyringUnavailable with the reason in plain words, so a caller can
 * say why and keep what it has.
 */

/** The service every harness item is filed under. */
export const KEYRING_SERVICE = "agentic-harness";

/** A place to keep a few named secrets, each a string. */
export interface SecretStore {
	/** What the person calls it, for messages: "the Keychain". */
	readonly name: string;
	/** The secret under `account`, or null when there is none. */
	read(account: string): Promise<string | null>;
	/** Keep `value` under `account`, replacing what was there. */
	write(account: string, value: string): Promise<void>;
	/** Remove what is under `account`; nothing there is no error. */
	remove(account: string): Promise<void>;
}

/** The store could not be reached, said in words a person can act on. */
export class KeyringUnavailable extends Error {
	readonly store: string;
	readonly reason: string;

	constructor(store: string, reason: string) {
		super(`${store} can't be reached: ${reason}`);
		this.name = "KeyringUnavailable";
		this.store = store;
		this.reason = reason;
	}
}

/** The message of whatever was thrown, for a reason. */
export function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
