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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	indexSessionLogs,
	PASS_STOPPED,
} from "../../../extensions/spend-workflow/indexer.ts";
import { claimLease } from "../../../extensions/spend-workflow/keeper.ts";
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

/** A session log under `sessions` with a few billed turns in it. */
function aSessionLog(sessions: string, name: string): string {
	const session = join(sessions, "--work--");
	mkdirSync(session, { recursive: true });
	const lines = Array.from({ length: 5 }, (_, i) =>
		JSON.stringify({
			id: `${name}-e${i}`,
			type: "message",
			timestamp: `2026-10-01T21:46:${String(i).padStart(2, "0")}.000Z`,
			message: {
				role: "assistant",
				model: "claude-opus-5",
				usage: { input: 1, output: 1, cost: { total: 0.01 } },
				content: [{ type: "text", text: `turn ${i} of ${name}` }],
			},
		}),
	);
	const path = join(session, `2026-10-01T21-46-00-000Z_${name}.jsonl`);
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
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

	it("stops being renewed once released", async () => {
		const release = claimLease(scratch, Date.now(), 30 * 60_000, 10);
		release?.();
		// Several renewals' worth at 10 ms each, so a leftover one would show.
		await new Promise((waited) => setTimeout(waited, 60));
		expect(
			() => statSync(join(scratch, "ledger-pass.lease")),
			"a released lease left on disk",
		).toThrow();
	});
});
