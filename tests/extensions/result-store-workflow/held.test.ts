/**
 * A restarted host reaps the stored results of a conversation no host
 * roster holds, and keeps the rest.
 *
 * A host stop quits its conversations without deleting anything, so a
 * dead host owner alone never proves a conversation is finished. Only
 * the rosters' definitive unheld does; any doubt keeps the results.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import resultStore from "../../../extensions/result-store-workflow/index.ts";
import {
	openSessionStore,
	sessionResultDir,
} from "../../../lib/core/result/index.ts";
import { installHost } from "../../../lib/core/session/index.ts";
import { rosterDir } from "../../../lib/core/session/roster.ts";
import { extensionRunner } from "../../support/extension-runner.ts";
import { resultSession } from "../../support/result-session.ts";

// A pid past pid_max, from a boot that is not this one: proven gone.
const CRASHED = {
	pid: 2 ** 22 + 1,
	startedAt: 1000,
	bootId: "before",
	startTicks: 10,
};

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function host(owner: typeof CRASHED | { pid: number; startedAt: number }) {
	const end = installHost({
		kind: "pi-durable",
		// The owner record names this key, so the roster read is held to it.
		key: "test-attended",
		owner,
		holds: () => "idle",
		env: () => {
			throw new Error("Roster reaping tests do not consume host env");
		},
		hints: () => ({}),
		close: () => {},
		stamp: () => {},
	});
	cleanups.push(end);
	return end;
}
function conversation() {
	const ctx = resultSession();
	cleanups.push(() =>
		rmSync(sessionResultDir(ctx), { recursive: true, force: true }),
	);
	return ctx;
}
function rosterHolding(...ids: string[]) {
	rosterOf("test-attended", ids);
}
function rosterOf(key: string, ids: string[]) {
	const dir = rosterDir();
	mkdirSync(dir, { recursive: true });
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(
		join(dir, `${key}.json`),
		JSON.stringify({
			v: 1,
			key,
			sessions: ids.map((sessionId) => ({
				sessionId,
				file: `/sessions/${sessionId}.jsonl`,
				cwd: "/work",
				attended: true,
				since: new Date().toISOString(),
			})),
		}),
	);
}
async function restartHost() {
	host({ pid: process.pid, startedAt: Date.now() });
	const started = extensionRunner(resultStore, process.cwd());
	await started.start();
	return started;
}

describe("results a crashed host left behind", () => {
	it("are reaped for an unheld conversation and kept for a held one", async () => {
		const closed = conversation(),
			held = conversation();
		const end = host(CRASHED);
		const gone = openSessionStore(closed).put("closed");
		const kept = openSessionStore(held).put("held");
		end();
		rosterHolding(held.sessionManager.getSessionId());
		const started = await restartHost();
		expect(
			openSessionStore(closed).has(gone.handle),
			"a conversation no roster holds loses its results",
		).toBe(false);
		expect(openSessionStore(held).read(kept.handle)).toBe("held");
		expect(started.errors).toEqual([]);
	});

	it("are kept when their own host's roster is missing, whatever the others say", async () => {
		const closed = conversation();
		const end = host(CRASHED);
		const kept = openSessionStore(closed).put("closed");
		end();
		rosterOf("other-background", []);
		const started = await restartHost();
		expect(openSessionStore(closed).read(kept.handle)).toBe("closed");
		expect(started.errors).toEqual([]);
	});

	it("are kept when no roster can say who is held", async () => {
		const closed = conversation();
		const end = host(CRASHED);
		const kept = openSessionStore(closed).put("closed");
		end();
		const started = await restartHost();
		expect(openSessionStore(closed).read(kept.handle)).toBe("closed");
		expect(started.errors).toEqual([]);
	});
});
