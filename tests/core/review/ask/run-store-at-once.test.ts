/**
 * The run store when several writers reach one change's ledger at once:
 * parallel calls in a session, two sessions, and a lock another process
 * holds or left behind.
 */
import { spawn } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AskRun, ChangeRef } from "../../../../lib/core/review/index.ts";
import { createRunStore } from "../../../../lib/core/review/index.ts";

const change: ChangeRef = {
	provider: "github",
	repo: { key: "github:Shopify/world" },
	id: "42",
	label: "Shopify/world#42",
};

function run(over: Partial<AskRun> = {}): AskRun {
	return {
		id: "council-20260730000000000-000001",
		round: "council",
		startedAt: "2026-07-30T00:00:00.000Z",
		participants: [{ id: "hawk", role: "reviewer" }],
		outcomes: [{ participantId: "hawk", findingIds: [1] }],
		...over,
	};
}

describe("writing one change's ledger from several places at once", () => {
	// Every write reads the ledger, changes one round and writes it
	// back. Two of those at once, from two parallel tool calls in one
	// session or from two sessions on one change, used to tear the file
	// or quietly drop one of the rounds. On 2026-09-23 two collects run
	// together left a ledger that no longer parsed.
	let root: string;
	const ledger = () => join(root, "github_github_Shopify_world_42.json");
	const lock = () => `${ledger()}.lock`;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "run-store-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function sleeper() {
		const child = spawn("sleep", ["30"], { stdio: "ignore" });
		return child;
	}

	async function gonePid(): Promise<number> {
		const child = spawn("true", [], { stdio: "ignore" });
		await new Promise((done) => child.on("exit", done));
		return child.pid ?? 0;
	}

	it("keeps both of two rounds settled at once", async () => {
		const store = createRunStore(root);
		const first = run({ id: "council-a", outcomes: [], open: true });
		const second = run({ id: "council-b", outcomes: [], open: true });
		await store.record(change, first);
		await store.record(change, second);

		await Promise.all([
			store.keep(change, { ...first, open: undefined }),
			store.keep(change, { ...second, open: undefined }),
		]);

		const held = await store.list(change);
		expect(held.map((r) => [r.id, r.open])).toEqual([
			["council-a", undefined],
			["council-b", undefined],
		]);
	});

	it("keeps every one of many rounds recorded at once", async () => {
		const store = createRunStore(root);
		const ids = Array.from({ length: 12 }, (_, n) => `council-${n}`);

		await Promise.all(ids.map((id) => store.record(change, run({ id }))));

		expect((await store.list(change)).map((r) => r.id).sort()).toEqual(
			[...ids].sort(),
		);
	});

	it("keeps both when two stores over one directory write at once", async () => {
		// Two stores stand in for two sessions: nothing in memory is
		// shared between them, only the directory.
		const one = createRunStore(root);
		const two = createRunStore(root);

		await Promise.all([
			one.record(change, run({ id: "council-a" })),
			two.record(change, run({ id: "council-b" })),
		]);

		expect((await one.list(change)).map((r) => r.id).sort()).toEqual([
			"council-a",
			"council-b",
		]);
	});

	it("waits for a write another live process is making", async () => {
		const holder = sleeper();
		try {
			writeFileSync(lock(), String(holder.pid));
			const store = createRunStore(root);

			let landed = false;
			const writing = store.record(change, run()).then(() => {
				landed = true;
			});
			// A write that doesn't land leaves nothing to wait on, so this
			// pause, some fifteen of the lock's 20 ms retries, is the case.
			await new Promise((done) => setTimeout(done, 300));
			expect(
				landed,
				"the record waits while another live process holds the lock",
			).toBe(false);

			rmSync(lock());
			await writing;
			expect(await store.list(change)).toHaveLength(1);
		} finally {
			holder.kill();
		}
	});

	it("takes over a lock whose process has gone", async () => {
		writeFileSync(lock(), String(await gonePid()));
		const store = createRunStore(root);

		await store.record(change, run());

		expect(await store.list(change)).toHaveLength(1);
		expect(readdirSync(root)).toEqual(["github_github_Shopify_world_42.json"]);
	});

	it("takes over a lock older than any write takes, whoever holds it", async () => {
		// A pid can be reused, so a live pid alone does not prove the
		// lock is still somebody's.
		const holder = sleeper();
		try {
			writeFileSync(lock(), String(holder.pid));
			const old = new Date(Date.now() - 10 * 60 * 1000);
			utimesSync(lock(), old, old);
			const store = createRunStore(root);

			await store.record(change, run());

			expect(await store.list(change)).toHaveLength(1);
		} finally {
			holder.kill();
		}
	});
});
