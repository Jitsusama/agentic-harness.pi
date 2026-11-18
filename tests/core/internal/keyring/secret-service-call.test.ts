import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	callingEntries,
	secretServiceStore,
} from "../../../../lib/core/internal/keyring/secret-service.ts";
import { KeyringUnavailable } from "../../../../lib/core/internal/keyring/store.ts";

/** A stand-in for secret-service-call.mjs, by its name in calls/. */
function call(name: string): string {
	return fileURLToPath(new URL(`./calls/${name}.mjs`, import.meta.url));
}

describe("the Secret Service's calls, each in a process of its own", () => {
	const before = process.env.KEYRING_CALL_FILE;

	beforeEach(() => {
		const folder = mkdtempSync(join(tmpdir(), "keyring-call-"));
		process.env.KEYRING_CALL_FILE = join(folder, "kept.json");
	});

	afterEach(() => {
		if (before === undefined) delete process.env.KEYRING_CALL_FILE;
		else process.env.KEYRING_CALL_FILE = before;
	});

	it("reads back what it wrote and removes it", async () => {
		const store = secretServiceStore(callingEntries(call("remembers")));

		await store.write("slack-credentials", "value");
		expect(await store.read("slack-credentials")).toBe("value");

		await store.remove("slack-credentials");
		expect(await store.read("slack-credentials")).toBeNull();
	});

	it("fails the one call when the keyring crashes, rather than the process that asked", async () => {
		const store = secretServiceStore(callingEntries(call("crashes")));

		const read = store.read("slack-credentials");

		await expect(read).rejects.toBeInstanceOf(KeyringUnavailable);
		await expect(read).rejects.toThrow("SIGSEGV");
	});
});
