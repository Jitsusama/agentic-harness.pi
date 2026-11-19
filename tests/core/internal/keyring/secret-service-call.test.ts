import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
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
import {
	KEYRING_SERVICE,
	KeyringUnavailable,
} from "../../../../lib/core/internal/keyring/store.ts";

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

/** The bytes a pipe gives a reader at once, on Linux and macOS. */
const PIPE_READ = 65_536;

/**
 * A long text of two-byte characters that, sent after `before`, has one
 * of them straddle the pipe's first read, so a reader that decodes each
 * read alone breaks it.
 */
function splitting(before: string): string {
	const lead = (PIPE_READ - Buffer.byteLength(before)) % 2 === 0 ? "a" : "";
	return `${lead}${"é".repeat(40_000)}`;
}

/** The real secret-service-call.mjs. */
function realCall(): string {
	return fileURLToPath(
		new URL(
			"../../../../lib/core/internal/keyring/secret-service-call.mjs",
			import.meta.url,
		),
	);
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
		// A held call left by a failed case answers and ends, rather than waiting on.
		letThemGo();
		// And a lingering call the store failed to end is ended here.
		const lingered = join(
			dirname(process.env.KEYRING_CALL_FILE ?? ""),
			"lingers.pid",
		);
		if (existsSync(lingered)) {
			try {
				process.kill(Number(readFileSync(lingered, "utf8")), "SIGKILL");
			} catch {
				// Already ended, as it should be.
			}
		}
		rmSync(dirname(process.env.KEYRING_CALL_FILE ?? ""), {
			recursive: true,
			force: true,
		});
		if (before === undefined) delete process.env.KEYRING_CALL_FILE;
		else process.env.KEYRING_CALL_FILE = before;
	});

	it("reads back what it wrote and removes it", async () => {
		const store = secretServiceStore(callingEntries(call("remembers")));

		await store.write("slack-credentials", "value");
		expect(await store.read("slack-credentials")).toBe("value");
		expect(
			JSON.parse(readFileSync(process.env.KEYRING_CALL_FILE ?? "", "utf8")),
			"each call should name the harness's service",
		).toEqual({ [`${KEYRING_SERVICE}/slack-credentials`]: "value" });

		await store.remove("slack-credentials");
		expect(await store.read("slack-credentials")).toBeNull();
	}, 30_000);

	it("fails the one call when the keyring crashes, rather than the process that asked", async () => {
		const store = secretServiceStore(callingEntries(call("crashes")));

		const read = store.read("slack-credentials");

		await expect(read).rejects.toBeInstanceOf(KeyringUnavailable);
		await expect(
			read,
			"the reason should be the line naming the error, not stderr's last",
		).rejects.toThrow(/stopped by SIGKILL: Error: the entry faulted$/);
	}, 30_000);

	it("says the one line of node's report that names what went wrong", async () => {
		const read = secretServiceStore(callingEntries(call("stumbles"))).read("x");

		await expect(read).rejects.toThrow(
			/reached: Error \[ERR_MODULE_NOT_FOUND\]: Cannot find package '@napi-rs\/no-such-keyring' imported from [^\n]+$/,
		);
	}, 30_000);

	it("says why when the call refuses, complains or answers nothing readable", async () => {
		const cases: [string, string][] = [
			["refuses", "the collection is locked"],
			["complains", "the call could not start"],
			["garbles", "answered nothing readable"],
		];
		for (const [stand, why] of cases) {
			const read = secretServiceStore(callingEntries(call(stand))).read("x");

			await expect(read, stand).rejects.toBeInstanceOf(KeyringUnavailable);
			await expect(read, stand).rejects.toThrow(why);
		}
	}, 30_000);

	it("fails a call whose node can't start, rather than the process that asked", async () => {
		const store = secretServiceStore(
			callingEntries(call("remembers"), "/nonexistent/node"),
		);

		await expect(store.write("x", "value")).rejects.toBeInstanceOf(
			KeyringUnavailable,
		);
	}, 30_000);

	it("takes the answer of a call that lingers after giving it, and ends that call", async () => {
		const store = secretServiceStore(callingEntries(call("lingers")));

		expect(await store.read("x")).toBe("value");
		const pid = Number(
			readFileSync(
				join(dirname(process.env.KEYRING_CALL_FILE ?? ""), "lingers.pid"),
				"utf8",
			),
		);
		await vi.waitFor(
			() =>
				expect(
					() => process.kill(pid, 0),
					"the lingering call should have been ended once it answered",
				).toThrow("ESRCH"),
			{ timeout: 20_000 },
		);
	}, 30_000);

	it("brings a long answer back whole across the pipe's reads", async () => {
		// The answer is the stand-in's; what this holds is the store's own
		// decoding of what comes back, split where its line is.
		const store = secretServiceStore(callingEntries(call("remembers")));
		const value = splitting('{"value":"');

		await store.write("x", value);

		expect(await store.read("x")).toBe(value);
	}, 30_000);

	it("reads a long request whole across the pipe's reads, in the real call", () => {
		// An unknown act is echoed in the refusal before the module loads, so
		// this reads the real call's stdin without touching the keyring.
		const act = splitting(
			`{"service":"${KEYRING_SERVICE}","account":"x","act":"`,
		);

		const ran = spawnSync(process.execPath, [realCall()], {
			input: JSON.stringify({ service: KEYRING_SERVICE, account: "x", act }),
			encoding: "utf8",
			timeout: 20_000,
		});

		expect(ran.status, ran.stderr).toBe(0);
		expect(JSON.parse(ran.stdout)).toEqual({
			error: `no such keyring call: ${act}`,
		});
	}, 30_000);

	it("loads the real keyring module, with the entry and calls it uses", () => {
		const ran = spawnSync(process.execPath, [realCall()], {
			input: JSON.stringify({
				service: KEYRING_SERVICE,
				account: "x",
				act: "write",
			}),
			encoding: "utf8",
			timeout: 20_000,
		});

		expect(ran.status, ran.stderr).toBe(0);
		expect(
			JSON.parse(ran.stdout),
			"a write with no value should be refused by the call, after its module loaded",
		).toEqual({ error: "a write needs a value" });
	}, 30_000);

	it("says what the keyring module lacks, rather than failing as a keyring out of reach", () => {
		const cases: [string, object, object][] = [
			[
				"none",
				{ act: "read" },
				{ error: "its keyring module has no AsyncEntry" },
			],
			[
				"reads",
				{ act: "write", value: "value" },
				{ error: "its keyring module's AsyncEntry has no setPassword" },
			],
			["reads", { act: "read" }, { value: null }],
		];
		for (const [shape, asked, answered] of cases) {
			const ran = spawnSync(
				process.execPath,
				["--import", call("swaps-the-module"), realCall()],
				{
					input: JSON.stringify({
						service: KEYRING_SERVICE,
						account: "x",
						...asked,
					}),
					encoding: "utf8",
					env: { ...process.env, KEYRING_MODULE: shape },
					timeout: 20_000,
				},
			);

			expect(ran.status, ran.stderr).toBe(0);
			expect(
				JSON.parse(ran.stdout),
				`${shape}: ${JSON.stringify(asked)}`,
			).toEqual(answered);
		}
	}, 30_000);

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

	it("shares a failed read without keeping the failure", async () => {
		const store = secretServiceStore(callingEntries(call("holds")));

		const reads = [store.read("fails-x"), store.read("fails-x")];
		await vi.waitFor(() => expect(running(), "one call should start").toBe(1), {
			timeout: 20_000,
		});
		letThemGo();

		for (const read of reads)
			await expect(read).rejects.toThrow("refused fails-x");
		await expect(store.read("fails-x")).rejects.toThrow("refused fails-x");
		expect(starts(), "the later read should ask again").toHaveLength(2);
	}, 30_000);

	it("frees each place a failed call held", async () => {
		const store = secretServiceStore(callingEntries(call("holds")));
		letThemGo();

		const failing = Array.from({ length: 4 }, (_, n) =>
			store.read(`fails-${n}`).catch((error: unknown) => error),
		);
		for (const failed of await Promise.all(failing)) {
			expect(failed).toBeInstanceOf(KeyringUnavailable);
		}

		expect(
			await store.read("after"),
			"a call after four failures should run",
		).toBe("after");
	}, 30_000);

	it("sends a read asked after a write to a call of its own", async () => {
		const store = secretServiceStore(callingEntries(call("holds")));

		const before = store.read("slack-credentials");
		const written = store.write("slack-credentials", "new");
		const after = store.read("slack-credentials");
		await vi.waitFor(
			() => expect(running(), "the read, the write and the later read").toBe(3),
			{ timeout: 20_000 },
		);
		letThemGo();

		await Promise.all([before, written, after]);
		expect(starts().map((start) => start.account)).toHaveLength(3);
	}, 30_000);

	it("never shares a read asked during a write or remove once it has ended", async () => {
		for (const act of ["write", "remove"]) {
			const store = secretServiceStore(callingEntries(call("holds")));
			const account = `during-${act}`;
			const changed =
				act === "write" ? store.write(account, "new") : store.remove(account);
			const during = store.read(account);
			await vi.waitFor(
				() => expect(running(), `the ${act} and the read during it`).toBe(2),
				{ timeout: 20_000 },
			);

			writeFileSync(
				join(dirname(process.env.KEYRING_CALL_FILE ?? ""), `go-${act}`),
				"",
			);
			await changed;
			const readBack = store.read(account);
			await vi.waitFor(
				() =>
					expect(running(), `the read back after the ${act}, on its own`).toBe(
						2,
					),
				{ timeout: 20_000 },
			);
			letThemGo();

			await Promise.all([during, readBack]);
			rmSync(join(dirname(process.env.KEYRING_CALL_FILE ?? ""), "go"));
			rmSync(join(dirname(process.env.KEYRING_CALL_FILE ?? ""), `go-${act}`));
		}
	}, 60_000);
});
