import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	callingEntries,
	secretServiceStore,
} from "../../../../lib/core/internal/keyring/secret-service.ts";
import { KeyringUnavailable } from "../../../../lib/core/internal/keyring/store.ts";

/** What holds.mjs said of each call it started: its account and how many were running. */
function starts(): { account: string; running: number }[] {
	const folder = dirname(process.env.KEYRING_CALL_FILE ?? "");
	return readFileSync(join(folder, "starts"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

/** Lets every held call answer. */
function letThemGo(): void {
	writeFileSync(join(dirname(process.env.KEYRING_CALL_FILE ?? ""), "go"), "");
}

/** How many held calls are running now. */
function running(): number {
	return readdirSync(
		join(dirname(process.env.KEYRING_CALL_FILE ?? ""), "running"),
	).length;
}

/** A stand-in for secret-service-call.mjs, by its name in calls/. */
function call(name: string): string {
	return fileURLToPath(new URL(`./calls/${name}.mjs`, import.meta.url));
}

describe("the Secret Service's calls, each in a process of its own", () => {
	const before = process.env.KEYRING_CALL_FILE;

	beforeEach(() => {
		const folder = mkdtempSync(join(tmpdir(), "keyring-call-"));
		process.env.KEYRING_CALL_FILE = join(folder, "kept.json");
		mkdirSync(join(folder, "running"));
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

	it("runs at most four calls at once, the rest waiting their turn", async () => {
		const store = secretServiceStore(callingEntries(call("holds")));
		const accounts = Array.from({ length: 8 }, (_, n) => `account-${n}`);

		const reads = accounts.map((account) => store.read(account));
		await vi.waitFor(
			() => expect(running(), "four calls should start").toBe(4),
			{
				timeout: 20_000,
			},
		);
		letThemGo();

		expect(await Promise.all(reads)).toEqual(accounts);
		expect(
			Math.max(...starts().map((start) => start.running)),
			"no more than four calls should ever run at once",
		).toBe(4);
	}, 30_000);

	it("shares one call between reads of an account asked at once", async () => {
		const store = secretServiceStore(callingEntries(call("holds")));

		const reads = [
			store.read("slack-credentials"),
			store.read("slack-credentials"),
		];
		await vi.waitFor(() => expect(running(), "one call should start").toBe(1), {
			timeout: 20_000,
		});
		letThemGo();

		expect(await Promise.all(reads)).toEqual([
			"slack-credentials",
			"slack-credentials",
		]);
		const later = await store.read("slack-credentials");

		expect(later, "a later read should still answer").toBe("slack-credentials");
		expect(
			starts(),
			"the later read should start a call of its own",
		).toHaveLength(2);
	}, 30_000);
});
