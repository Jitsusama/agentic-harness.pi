import { describe, expect, it } from "vitest";
import {
	type KeyringEntry,
	secretServiceStore,
	whatWentWrong,
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

describe("whatWentWrong", () => {
	it("takes the first line that heads an error, not a later one", () => {
		expect(
			whatWentWrong(
				"file:///call.mjs:3\n  ^\n\nTypeError: the headline\n    at x\n  [cause]: RangeError: a later one\n",
			),
		).toBe("TypeError: the headline");
	});

	it("says a Rust panic's message and where it panicked", () => {
		expect(
			whatWentWrong(
				"thread '<unnamed>' panicked at src/lib.rs:4:9:\ncalled `Option::unwrap()` on a `None` value\nnote: run with `RUST_BACKTRACE=1`\n",
			),
		).toBe(
			"called `Option::unwrap()` on a `None` value (panicked at src/lib.rs:4:9)",
		);
	});

	it("keeps all of what names no error, on one line and cut short", () => {
		expect(whatWentWrong("the call\n\ncould not start\n")).toBe(
			"the call / could not start",
		);
		const long = whatWentWrong("x".repeat(400)) ?? "";
		expect(long).toHaveLength(301);
		expect(long.endsWith("…")).toBe(true);
	});

	it("says nothing when stderr was empty", () => {
		expect(whatWentWrong("\n  \n")).toBeUndefined();
	});
});
