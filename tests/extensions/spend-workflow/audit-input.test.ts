import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AUDIT_QUERIES,
	periods,
} from "../../../extensions/spend-workflow/audit";
import {
	type AuditQuery,
	gatherAudit,
} from "../../../extensions/spend-workflow/audit-input";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const { current, prior } = periods(NOW);
let sessionsDir: string;
let asked: string[];

/** A ledger that answers each audit query it knows with fixed rows. */
const ledger: AuditQuery = async (sql) => {
	asked.push(sql);
	if (sql === AUDIT_QUERIES.sessions(current)) return [{ sessions: 40 }];
	if (sql === AUDIT_QUERIES.sessions(prior)) return [{ sessions: 30 }];
	if (sql === AUDIT_QUERIES.spend(current)) return [{ turns: 9, cost: 3 }];
	if (sql === AUDIT_QUERIES.questReads(current))
		return [{ kind: "documents", calls: 2, sessions: 1, chars: 900 }];
	return [];
};

beforeEach(() => {
	sessionsDir = mkdtempSync(join(tmpdir(), "audit-input-"));
	asked = [];
});

afterEach(() => {
	rmSync(sessionsDir, { recursive: true, force: true });
});

describe("gathering the weekly audit", () => {
	it("holds the week against the one before, by sessions active", async () => {
		const input = await gatherAudit(ledger, { now: NOW, sessionsDir });

		expect(input.period).toEqual(current);
		expect(input.spend.now).toEqual({ turns: 9, cost: 3 });
		expect(input.questReads?.active).toEqual({ now: 40, before: 30 });
		expect(input.questReads?.now).toEqual([
			{ kind: "documents", calls: 2, sessions: 1, chars: 900 },
		]);
		expect(input.unread).toBe(0);
	});

	it("says nothing of on-demand tools when it is not told which they are", async () => {
		const input = await gatherAudit(ledger, { now: NOW, sessionsDir });

		expect(input.loading).toBeUndefined();
		expect(asked.some((sql) => sql.includes("name IN ("))).toBe(false);
	});

	it("asks after the on-demand tools it is told of", async () => {
		const input = await gatherAudit(ledger, {
			now: NOW,
			sessionsDir,
			deferred: ["slack", "jobs"],
		});

		expect(input.loading?.sessions).toBe(40);
		expect(asked).toContain(AUDIT_QUERIES.hidden(current, ["slack", "jobs"]));
	});
});
