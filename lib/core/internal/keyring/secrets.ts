/**
 * The desktop's secret store, as the harness's own process reaches it:
 * the Secret Service keyring on Linux, the Keychain on macOS.
 *
 * Only pi's process talks to it, never a command the agent runs: the
 * agent's fence keeps fenced commands off the session bus, and a secret
 * printed by a shell command would land in the transcript.
 *
 * The store is a module-level choice so tests can put a memory store in
 * its place: no test may touch the developer's real keyring, and the
 * unit suite's setup puts one in place for every test. The choice is
 * kept on `globalThis`, so a test that loads this module afresh still
 * finds the store its setup chose.
 */

import { keychainStore } from "./keychain.ts";
import { secretServiceStore } from "./secret-service.ts";
import type { SecretStore } from "./store.ts";

const CHOSEN = Symbol.for("agentic-harness.keyring.store");

interface Holder {
	[CHOSEN]?: SecretStore;
}

const holder: Holder = globalThis as Holder;

/** The store for this platform, or the one a test put in its place. */
export function secretStore(): SecretStore {
	holder[CHOSEN] ??=
		process.platform === "darwin" ? keychainStore() : secretServiceStore();
	return holder[CHOSEN];
}

/** Put `store` in place of the platform's, for tests; undefined restores it. */
export function useSecretStore(store: SecretStore | undefined): void {
	holder[CHOSEN] = store;
}
