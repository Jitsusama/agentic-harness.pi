/** Durable session paths and conservative reaping through the result lifecycle. */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	claimArtifactDirectory,
	prepareArtifactOwnership,
} from "../../../lib/core/internal/artifacts/ownership.ts";
import {
	cleanupSessionResults,
	openSessionStore,
	RESULT_ROOT,
	reapAbandonedResults,
	sessionResultDir,
} from "../../../lib/core/result/location.ts";
import {
	installHost,
	type SessionOwner,
} from "../../../lib/core/session/index.ts";
import { resultSession } from "../../support/result-session.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function session() {
	const ctx = resultSession();
	cleanups.push(() =>
		rmSync(sessionResultDir(ctx), { recursive: true, force: true }),
	);
	return ctx;
}
function host(owner: SessionOwner) {
	const end = installHost({
		kind: "pi-durable",
		key: "artifact-host",
		owner,
		holds: () => "idle",
		env: () => {
			throw new Error("Artifact tests do not consume host env");
		},
		hints: () => ({}),
		close: () => {},
		stamp: () => {},
	});
	cleanups.push(end);
	return end;
}
const BEFORE = { pid: 101, startedAt: 1000, bootId: "before", startTicks: 10 };
const AFTER = { pid: 202, startedAt: 2000, bootId: "after", startTicks: 20 };

describe("session artifact ownership", () => {
	it("retains two callers' handles across a hosted stop and a new host owner", async () => {
		const a = session();
		const b = session();
		const stop = host(BEFORE);
		const first = openSessionStore(a).put('{"owner":"a"}');
		const second = openSessionStore(b).put('{"owner":"b"}');
		const dirA = sessionResultDir(a);
		cleanupSessionResults(a);
		cleanupSessionResults(b);
		stop();
		// A crashed host is not a deliberate close: unavailable roster evidence preserves both.
		await reapAbandonedResults({
			root: RESULT_ROOT,
			isPidAlive: () => false,
			standing: async () => "gone",
		});
		host(AFTER);
		await prepareArtifactOwnership(a);
		claimArtifactDirectory(sessionResultDir(a), a);
		claimArtifactDirectory(sessionResultDir(b), b);
		expect(sessionResultDir(a)).toBe(dirA);
		expect(openSessionStore(a).read(first.handle)).toBe('{"owner":"a"}');
		expect(openSessionStore(b).read(second.handle)).toBe('{"owner":"b"}');
		expect(
			openSessionStore(a).has(second.handle),
			"A cannot read B's persisted handle",
		).toBe(false);
		expect(
			JSON.parse(readFileSync(join(dirA, "owner.json"), "utf8")).owner,
		).toMatchObject({
			...AFTER,
			session: a.sessionManager.getSessionId(),
			host: "artifact-host",
		});
	});

	it.each(["held", "unknown"] as const)(
		"preserves a dead hosted owner when the catalogue says %s",
		async (status) => {
			const ctx = session();
			host(BEFORE);
			const payload = openSessionStore(ctx).put("retained");
			await reapAbandonedResults({
				root: RESULT_ROOT,
				isPidAlive: () => false,
				standing: async () => "gone",
				heldSessionStatus: async () => status,
			});
			expect(openSessionStore(ctx).read(payload.handle)).toBe("retained");
		},
	);

	it("reaps only a dead owner whose hosted conversation is definitively unheld", async () => {
		const a = session();
		const b = session();
		host(BEFORE);
		openSessionStore(a).put("a");
		const kept = openSessionStore(b).put("b");
		await reapAbandonedResults({
			root: RESULT_ROOT,
			isPidAlive: () => false,
			standing: async () => "gone",
			heldSessionStatus: async (id) =>
				id === a.sessionManager.getSessionId() ? "unheld" : "held",
		});
		expect(
			existsSync(sessionResultDir(a)),
			"A is reaped only after definitive close",
		).toBe(false);
		expect(openSessionStore(b).read(kept.handle)).toBe("b");
	});

	it("retains running, unknown and newly reclaimed owners", async () => {
		const ctx = session();
		host(BEFORE);
		const payload = openSessionStore(ctx).put("kept");
		for (const status of ["running", "unknown"] as const) {
			await reapAbandonedResults({
				root: RESULT_ROOT,
				isPidAlive: () => false,
				standing: async () => status,
				heldSessionStatus: async () => "unheld",
			});
			expect(openSessionStore(ctx).read(payload.handle)).toBe("kept");
		}
		await reapAbandonedResults({
			root: RESULT_ROOT,
			isPidAlive: () => false,
			standing: async () => {
				const file = join(sessionResultDir(ctx), "owner.json");
				const record = JSON.parse(readFileSync(file, "utf8"));
				writeFileSync(
					file,
					JSON.stringify({
						...record,
						owner: {
							...AFTER,
							session: ctx.sessionManager.getSessionId(),
							host: "artifact-host",
						},
					}),
				);
				return "gone";
			},
			heldSessionStatus: async () => "unheld",
		});
		expect(openSessionStore(ctx).read(payload.handle)).toBe("kept");
	});

	it("uses ticked plain-pi ownership for reaping and still removes plain quit results", async () => {
		const a = session();
		const b = session();
		await prepareArtifactOwnership(a);
		openSessionStore(a).put("a");
		const kept = openSessionStore(b).put("b");
		expect(
			JSON.parse(readFileSync(join(sessionResultDir(a), "owner.json"), "utf8"))
				.owner,
		).toMatchObject({ pid: process.pid });
		await reapAbandonedResults({
			root: RESULT_ROOT,
			isPidAlive: () => true,
			standing: async (owner) =>
				owner.session === undefined ? "gone" : "running",
		});
		expect(
			existsSync(sessionResultDir(a)),
			"a proven dead plain-pi owner is reaped",
		).toBe(false);
		// Put again before a graceful quit to exercise the separate plain-pi cleanup path.
		openSessionStore(b).put("b");
		expect(openSessionStore(b).read(kept.handle)).toBe("b");
		cleanupSessionResults(b);
		expect(
			existsSync(sessionResultDir(b)),
			"plain-pi quit removes its own results",
		).toBe(false);
	});

	it("preserves malformed or mismatched metadata instead of guessing ownership", async () => {
		const ctx = session();
		host(BEFORE);
		const payload = openSessionStore(ctx).put("kept");
		for (const metadata of [
			"not-json",
			JSON.stringify({ version: 1, session: "another-session", owner: BEFORE }),
		]) {
			writeFileSync(join(sessionResultDir(ctx), "owner.json"), metadata);
			await reapAbandonedResults({
				root: RESULT_ROOT,
				isPidAlive: () => false,
				standing: async () => "gone",
				heldSessionStatus: async () => "unheld",
			});
			expect(openSessionStore(ctx).read(payload.handle)).toBe("kept");
		}
	});
});
