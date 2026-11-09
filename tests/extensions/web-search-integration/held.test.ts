/**
 * A restarted host reaps the page bundles of a conversation no host
 * roster holds, and keeps the rest, since captures can carry a logged-in
 * page and must not linger once their conversation is closed for good.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import webSearchIntegration from "../../../extensions/web-search-integration/index.ts";
import { installHost } from "../../../lib/core/session/index.ts";
import { rosterDir } from "../../../lib/core/session/roster.ts";
import { diskSink, sessionDir } from "../../../lib/core/web/envelope/sink.ts";
import { extensionRunner } from "../../support/extension-runner.ts";
import { resultSession } from "../../support/result-session.ts";

vi.mock("../../../lib/core/web/browser.ts", async (original) => ({
	...(await original<typeof import("../../../lib/core/web/browser.ts")>()),
	closeBrowser: vi.fn(async () => {}),
	killBrowserSync: vi.fn(),
}));

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
		rmSync(sessionDir(ctx), { recursive: true, force: true }),
	);
	return ctx;
}
function rosterHolding(...ids: string[]) {
	const dir = rosterDir();
	mkdirSync(dir, { recursive: true });
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(
		join(dir, "test-attended.json"),
		JSON.stringify({
			v: 1,
			key: "test-attended",
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
	const started = extensionRunner(webSearchIntegration, process.cwd());
	await started.start();
	return started;
}

describe("page bundles a crashed host left behind", () => {
	it("are reaped for an unheld conversation and kept for a held one", async () => {
		const closed = conversation();
		const held = conversation();
		const end = host(CRASHED);
		diskSink(undefined, closed).writeText("dom.html", "closed");
		const kept = diskSink(undefined, held).writeText("dom.html", "held");
		end();
		rosterHolding(held.sessionManager.getSessionId());
		const started = await restartHost();
		expect(
			existsSync(sessionDir(closed)),
			"a conversation no roster holds loses its bundles",
		).toBe(false);
		expect(readFileSync(kept, "utf8")).toBe("held");
		expect(started.errors).toEqual([]);
	});

	it("are kept when no roster can say who is held", async () => {
		const closed = conversation();
		const end = host(CRASHED);
		const kept = diskSink(undefined, closed).writeText("dom.html", "closed");
		end();
		const started = await restartHost();
		expect(readFileSync(kept, "utf8")).toBe("closed");
		expect(started.errors).toEqual([]);
	});
});
