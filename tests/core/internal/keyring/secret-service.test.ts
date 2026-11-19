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
				"file:///call.mjs:3\n  ^\n\nTypeError: the headline\n    at x\nRangeError: a later one\n",
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
		expect(
			whatWentWrong(
				"thread 'main' (8143) panicked at src/lib.rs:4:9:\nthe entry faulted\n",
			),
			"a newer Rust names the thread's id too",
		).toBe("the entry faulted (panicked at src/lib.rs:4:9)");
		expect(
			whatWentWrong(
				"thread '<unnamed>' panicked at src/lib.rs:4:9:\nnote: run with `RUST_BACKTRACE=1`\n",
			),
			"a panic with no message is said by its place alone",
		).toBe("panicked at src/lib.rs:4:9");
	});

	it("takes node's own fatal heading", () => {
		expect(
			whatWentWrong(
				"\n<--- Last few GCs --->\n\nFATAL ERROR: Reached heap limit Allocation failed\n 1: 0xb8 node::Abort()\n",
			),
		).toBe("FATAL ERROR: Reached heap limit Allocation failed");
	});

	it("keeps all of what names no error, on one line and cut short", () => {
		expect(whatWentWrong("the call\n\ncould not start\n")).toBe(
			"the call / could not start",
		);
		expect(whatWentWrong("x".repeat(300)), "at the edge, kept whole").toBe(
			"x".repeat(300),
		);
		expect(whatWentWrong("x".repeat(301))).toBe(`${"x".repeat(300)}…`);
		expect(
			whatWentWrong(`Error: ${"x".repeat(400)}`),
			"a heading is cut too",
		).toHaveLength(301);
	});

	it("says nothing when stderr was empty", () => {
		expect(whatWentWrong("\n  \n")).toBeUndefined();
	});
});
