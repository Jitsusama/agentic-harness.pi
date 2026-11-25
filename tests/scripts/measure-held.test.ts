/**
 * A daily measure beside a session's pass that holds the ledger's write
 * lock still writes its report, as pi-measure.service didn't at 06:08,
 * 06:49 and 09:30 on 25 November, when all five of its tries met the
 * lock. OXUW1Y wrote the case.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	claimLease,
	readStamp,
} from "../../extensions/spend-workflow/keeper.ts";
import { openDb } from "../../lib/core/internal/sqlite/db.ts";
import { openTurnStore } from "../../lib/core/observability/index.ts";
import { stateDir } from "../../lib/internal/paths.ts";
import { measure, whileBusy } from "../../scripts/measure.ts";

/** Five tries, each meeting a 5 s busy timeout, fit well inside this. */
const PAST_EVERY_RETRY_MS = 60_000;

const KEPT = ["HOME", "XDG_STATE_HOME", "PI_CODING_AGENT_DIR"] as const;

describe("a measure beside a pass holding the ledger", () => {
	let home: string;
	const kept: Partial<Record<(typeof KEPT)[number], string>> = {};

	beforeEach(() => {
		// The measure finds its ledger and the session logs from these, so
		// a case of its own touches neither of the machine's.
		home = mkdtempSync(join(tmpdir(), "measure-held-"));
		for (const name of KEPT) {
			const value = process.env[name];
			if (value !== undefined) kept[name] = value;
		}
		process.env.HOME = home;
		process.env.XDG_STATE_HOME = join(home, ".local", "state");
		process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
		mkdirSync(join(home, ".pi", "agent", "sessions"), { recursive: true });
	});

	afterEach(() => {
		for (const name of KEPT) {
			const value = kept[name];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		vi.restoreAllMocks();
		rmSync(home, { recursive: true, force: true });
	});

	it(
		"writes the day's measure from the ledger as it stands, and says it didn't index",
		async () => {
			vi.spyOn(console, "error").mockImplementation(() => undefined);
			const dir = stateDir("observability");
			mkdirSync(dir, { recursive: true });
			const ledger = join(dir, "ledger.db");
			// Shape the ledger, then hold its lease and its write lock, as a
			// keeper's pass over a backlog does for minutes at a time.
			await (await openTurnStore(ledger)).close();
			const release = claimLease(dir);
			expect(release, "the case's own pass took the lease").toBeDefined();
			const holder = await openDb(ledger);
			await holder.exec("BEGIN IMMEDIATE");
			try {
				const out = await whileBusy(
					() =>
						measure({
							now: Date.now(),
							span: "day",
							out: join(home, "measure.md"),
							leaseWaitMs: 0,
						}),
					async () => undefined,
				);
				expect(existsSync(out), "the measure wrote its report").toBe(true);
				expect(readFileSync(out, "utf8")).toContain(
					"this measure didn't index the logs",
				);
			} finally {
				await holder.exec("ROLLBACK");
				await holder.close();
				release?.();
			}
		},
		PAST_EVERY_RETRY_MS,
	);

	it(
		"waits for a pass that frees the lease, then indexes",
		async () => {
			const dir = stateDir("observability");
			mkdirSync(dir, { recursive: true });
			const release = claimLease(dir);
			expect(release, "the case's own pass took the lease").toBeDefined();
			const freed = setTimeout(() => release?.(), 200);
			try {
				const out = await measure({
					now: Date.now(),
					span: "day",
					out: join(home, "measure.md"),
					leaseWaitMs: 60_000,
					leaseLookMs: 50,
				});

				expect(readFileSync(out, "utf8")).not.toContain("didn't index");
				expect(readStamp(dir)).toMatchObject({ ok: true, by: "measure" });
			} finally {
				clearTimeout(freed);
				release?.();
			}
		},
		PAST_EVERY_RETRY_MS,
	);

	it(
		"indexes and stamps its pass when nobody holds the lease",
		async () => {
			const out = await measure({
				now: Date.now(),
				span: "day",
				out: join(home, "measure.md"),
			});

			expect(readFileSync(out, "utf8")).not.toContain("didn't index");
			expect(readStamp(stateDir("observability"))).toMatchObject({
				ok: true,
				by: "measure",
			});
		},
		PAST_EVERY_RETRY_MS,
	);
});
