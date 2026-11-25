/**
 * A ledger pass ends cleanly when its session does, and a long one keeps
 * its lease.
 *
 * On 25 November every keeper's pass after optimus's restart died on
 * SQLITE_MISUSE: a session reloading or rolling over closed the ledger
 * under a pass still reading. Each failed pass was due again at once, so
 * passes ran back to back and the daily measure met the lock on every
 * try.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	indexSessionLogs,
	PASS_STOPPED,
} from "../../../extensions/spend-workflow/indexer.ts";
import {
	claimLease,
	readStamp,
	stampedPass,
} from "../../../extensions/spend-workflow/keeper.ts";
import {
	openTurnStore,
	type TurnStore,
} from "../../../lib/core/observability/index.ts";

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "pass-ends-"));
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

/** A session log under `sessions` with `turns` billed turns in it. */
function aSessionLog(sessions: string, name: string, turns = 5): string {
	const session = join(sessions, "--work--");
	mkdirSync(session, { recursive: true });
	const lines = Array.from({ length: turns }, (_, i) =>
		JSON.stringify({
			id: `${name}-e${i}`,
			type: "message",
			timestamp: `2026-10-01T21:46:${String(i).padStart(2, "0")}.000Z`,
			message: {
				role: "assistant",
				model: "claude-opus-5",
				usage: { input: 1, output: 1, cost: { total: 0.01 } },
				content: [{ type: "text", text: `turn ${i} of ${name} ${PADDING}` }],
			},
		}),
	);
	const path = join(session, `2026-10-01T21-46-00-000Z_${name}.jsonl`);
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

/** Enough words that a few hundred turns span several read chunks. */
const PADDING = "words ".repeat(40);

/** A signal that reads as fired from its `firesAt`th look on. */
function firingOnLook(firesAt: number): AbortSignal {
	const signal = new AbortController().signal;
	let looks = 0;
	Object.defineProperty(signal, "aborted", {
		get: () => {
			looks += 1;
			return looks >= firesAt;
		},
	});
	return signal;
}

/** `store`, firing `stop` once it has recorded its first session. */
function stoppingAfterOne(store: TurnStore, stop: AbortController): TurnStore {
	return new Proxy(store, {
		get(target, key) {
			const value: unknown = Reflect.get(target, key);
			if (typeof value !== "function") return value;
			if (key !== "recordSession") return value.bind(target);
			return async (...args: unknown[]) => {
				const answer: unknown = await value.apply(target, args);
				stop.abort();
				return answer;
			};
		},
	});
}

describe("a pass whose session ends", () => {
	it("stops before its next log and keeps the watermark of the one it finished", async () => {
		const sessions = join(scratch, "sessions");
		aSessionLog(sessions, "first");
		aSessionLog(sessions, "second");
		const marks = join(scratch, "ledger-watermarks.json");
		const store = await openTurnStore(join(scratch, "ledger.db"));
		const stop = new AbortController();
		try {
			await expect(
				indexSessionLogs(
					stoppingAfterOne(store, stop),
					marks,
					sessions,
					stop.signal,
				),
			).rejects.toThrow(PASS_STOPPED);
		} finally {
			await store.close();
		}

		const kept: { sizes?: Record<string, number> } = JSON.parse(
			readFileSync(marks, "utf8"),
		);
		expect(
			Object.keys(kept.sizes ?? {}),
			"the logs whose watermark the stopped pass kept",
		).toHaveLength(1);
	});

	it("stops within a long log and writes none of it", async () => {
		const sessions = join(scratch, "sessions");
		// Some 200 KB: more than one 64 KB chunk, so the third look, the
		// one at the log's second chunk, falls within it.
		aSessionLog(sessions, "long", 600);
		const marks = join(scratch, "ledger-watermarks.json");
		const store = await openTurnStore(join(scratch, "ledger.db"));
		try {
			await expect(
				indexSessionLogs(store, marks, sessions, firingOnLook(3)),
			).rejects.toThrow(PASS_STOPPED);
			expect(await store.total(), "turns the stopped pass wrote").toMatchObject(
				{ turns: 0 },
			);
		} finally {
			await store.close();
		}
	});

	it("leaves the stamp as the last pass that ended wrote it", async () => {
		await expect(
			stampedPass(scratch, "keeper", () =>
				Promise.reject(new Error(PASS_STOPPED)),
			),
		).rejects.toThrow(PASS_STOPPED);

		expect(readStamp(scratch), "a stamp a stopped pass wrote").toBeUndefined();
	});

	it("reads nothing when its session has already ended", async () => {
		const sessions = join(scratch, "sessions");
		aSessionLog(sessions, "only");
		const store = await openTurnStore(join(scratch, "ledger.db"));
		try {
			await expect(
				indexSessionLogs(
					store,
					join(scratch, "ledger-watermarks.json"),
					sessions,
					AbortSignal.abort(),
				),
			).rejects.toThrow(PASS_STOPPED);
			expect(await store.total(), "turns the stopped pass wrote").toMatchObject(
				{ turns: 0 },
			);
		} finally {
			await store.close();
		}
	});
});

describe("a lease held through a long pass", () => {
	it("is marked fresh while held, so it never reads as left", async () => {
		const release = claimLease(scratch, Date.now(), 30 * 60_000, 10);
		expect(release, "the lease was taken").toBeDefined();
		const lease = join(scratch, "ledger-pass.lease");
		const hourAgo = new Date(Date.now() - 60 * 60_000);
		utimesSync(lease, hourAgo, hourAgo);
		try {
			// Several renewals' worth at 10 ms each, so one has run.
			await new Promise((renewed) => setTimeout(renewed, 100));
			expect(
				Date.now() - statSync(lease).mtimeMs,
				"how old the held lease reads",
			).toBeLessThan(60_000);
		} finally {
			release?.();
		}
	});

	it("stops being renewed once released", () => {
		vi.useFakeTimers();
		try {
			const release = claimLease(scratch, Date.now(), 30 * 60_000, 10);
			expect(vi.getTimerCount(), "renewals while held").toBe(1);
			release?.();
			expect(vi.getTimerCount(), "renewals once released").toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops being renewed once held past any pass's length", () => {
		vi.useFakeTimers();
		try {
			const lost = vi.fn();
			const release = claimLease(
				scratch,
				Date.now(),
				30 * 60_000,
				10,
				50,
				lost,
			);
			vi.advanceTimersByTime(60);
			const lease = join(scratch, "ledger-pass.lease");
			const hourAgo = new Date(Date.now() - 60 * 60_000);
			utimesSync(lease, hourAgo, hourAgo);
			vi.advanceTimersByTime(100);
			expect(
				Date.now() - statSync(lease).mtimeMs,
				"how old the lease reads, held past its bound",
			).toBeGreaterThan(59 * 60_000);
			expect(vi.getTimerCount(), "renewals still set").toBe(0);
			expect(lost, "times its holder was told to stop").toHaveBeenCalledOnce();
			release?.();
		} finally {
			vi.useRealTimers();
		}
	});

	// After a suspend, another pass takes the lease over by age while
	// this one still runs; writing on would put two writers on the ledger.
	it("tells its holder once another has taken it over", () => {
		vi.useFakeTimers();
		try {
			const lost = vi.fn();
			const release = claimLease(
				scratch,
				Date.now(),
				30 * 60_000,
				10,
				60 * 60_000,
				lost,
			);
			vi.advanceTimersByTime(15);
			expect(
				lost,
				"told while it still holds the lease",
			).not.toHaveBeenCalled();
			const lease = join(scratch, "ledger-pass.lease");
			rmSync(lease);
			writeFileSync(lease, String(process.ppid));
			vi.advanceTimersByTime(15);
			expect(lost, "times its holder was told to stop").toHaveBeenCalledOnce();
			expect(readFileSync(lease, "utf8"), "the new holder's lease").toBe(
				String(process.ppid),
			);
			release?.();
			expect(readFileSync(lease, "utf8"), "left to its new holder").toBe(
				String(process.ppid),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	// A live pid on a lease stamped a day ahead held every pass off the
	// ledger, the tool's, the keepers' and the measure's, with nothing to
	// override it.
	it("is taken over when marked further ahead than any renewal marks it", () => {
		const lease = join(scratch, "ledger-pass.lease");
		writeFileSync(lease, String(process.ppid));
		const dayAhead = new Date(Date.now() + 24 * 60 * 60_000);
		utimesSync(lease, dayAhead, dayAhead);
		const release = claimLease(scratch);
		try {
			expect(release, "the lease was taken over").toBeDefined();
			expect(readFileSync(lease, "utf8")).toBe(String(process.pid));
		} finally {
			release?.();
		}
	});

	it("stays with a live holder that marked it a moment ago", () => {
		const lease = join(scratch, "ledger-pass.lease");
		writeFileSync(lease, String(process.ppid));
		const release = claimLease(scratch);
		try {
			expect(release, "the lease was taken").toBeUndefined();
		} finally {
			release?.();
			rmSync(lease, { force: true });
		}
	});
});
