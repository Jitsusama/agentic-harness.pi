import { describe, expect, it } from "vitest";
import {
	type KeyringEntry,
	secretServiceStore,
} from "../../../../lib/core/internal/keyring/secret-service.ts";

/** Entries in memory, opened as the native module opens them. */
function memoryEntries() {
	const items = new Map<string, string>();
	const open = async (account: string): Promise<KeyringEntry> => ({
		async getPassword() {
			return items.get(account) ?? null;
		},
		async setPassword(password) {
			items.set(account, password);
		},
		async deleteCredential() {
			return items.delete(account);
		},
	});
	return { items, open };
}

describe("secretServiceStore", () => {
	it("reads back what it wrote and removes it", async () => {
		const entries = memoryEntries();
		const store = secretServiceStore(entries.open);

		await store.write("slack-credentials", "value");
		expect(await store.read("slack-credentials")).toBe("value");

		await store.remove("slack-credentials");
		expect(await store.read("slack-credentials")).toBeNull();
	});

	it("says the keyring can't be reached when no Secret Service answers", async () => {
		const store = secretServiceStore(async () => {
			throw new Error(
				"Platform failure: DBus error: Failed to connect to socket /run/user/1000/bus",
			);
		});

		await expect(store.read("slack-credentials")).rejects.toThrow(
			/The Secret Service keyring can't be reached: .*Failed to connect/,
		);
	});

	it("says so when the person turns the unlock prompt down", async () => {
		const entries = memoryEntries();
		const store = secretServiceStore(async (account) => ({
			...(await entries.open(account)),
			async setPassword() {
				throw new Error("No storage access: prompt dismissed");
			},
		}));

		await expect(store.write("slack-credentials", "v")).rejects.toThrow(
			/prompt dismissed/,
		);
	});
});
