/**
 * A secret store in memory, for tests: none may reach the developer's
 * real keyring. `unreachable` makes every call throw as a locked or
 * missing keyring does.
 */

import {
	KeyringUnavailable,
	type SecretStore,
} from "../../lib/core/internal/keyring/store.ts";

/** A memory store, with its items open to the test. */
export interface MemorySecretStore extends SecretStore {
	readonly items: Map<string, string>;
	/** When set, every call throws KeyringUnavailable with this reason. */
	unreachable: string | undefined;
}

/** A fresh, empty memory store. */
export function memorySecretStore(): MemorySecretStore {
	const items = new Map<string, string>();
	const store: MemorySecretStore = {
		name: "The test keyring",
		items,
		unreachable: undefined,
		async read(account) {
			refuseWhenUnreachable();
			return items.get(account) ?? null;
		},
		async write(account, value) {
			refuseWhenUnreachable();
			items.set(account, value);
		},
		async remove(account) {
			refuseWhenUnreachable();
			items.delete(account);
		},
	};
	function refuseWhenUnreachable(): void {
		if (store.unreachable !== undefined) {
			throw new KeyringUnavailable(store.name, store.unreachable);
		}
	}
	return store;
}
