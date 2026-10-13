import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachCurrentSession } from "../../../extensions/quest-workflow/lifecycle";
import { livePeers, peersSaid } from "../../../extensions/quest-workflow/peers";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { localProcessDeps } from "../../../lib/internal/quest/process-liveness";
import type { QuestSession } from "../../../lib/quest/index";
import { createEnvGuard, succeeded } from "./_helpers";

const HOST = "host-a";
const SELF = { pid: 100, hostId: HOST };

function session(
	id: string,
	pid: number,
	extra: Partial<QuestSession> = {},
): QuestSession {
	return {
		id,
		status: "active",
		cwd: "/work",
		process: { hostId: HOST, pid, startToken: "tok" },
		...extra,
	};
}

/** Every pid alive with the recorded start, except those named gone. */
function deps(gone: number[] = []) {
	return {
		localHostId: HOST,
		inspect: (pid: number) =>
			gone.includes(pid)
				? ({ kind: "gone" } as const)
				: ({ kind: "alive", startToken: "tok" } as const),
	};
}

describe("live peers", () => {
	it("names another running session on the quest", () => {
		const peers = livePeers([session("other", 200)], SELF, deps());
		expect(peers).toEqual([{ id: "other", cwd: "/work", pid: 200 }]);
	});

	it("never names this process, whichever session it runs", () => {
		expect(livePeers([session("mine", 100)], SELF, deps())).toEqual([]);
	});

	it("names the same session open in another process", () => {
		const peers = livePeers([session("mine", 300)], SELF, deps());
		expect(peers.map((p) => p.pid)).toEqual([300]);
	});

	it("leaves out sessions that ended, detached or carry no process", () => {
		const sessions = [
			session("gone", 200),
			session("left", 201, { status: "detached" }),
			{ id: "bare", status: "active" as const },
		];
		expect(livePeers(sessions, SELF, deps([200]))).toEqual([]);
	});

	it("says one peer and several in a sentence", () => {
		expect(peersSaid("QEST-1", [])).toBeUndefined();
		expect(peersSaid("QEST-1", [{ id: "a", pid: 1 }])).toMatch(
			/^Another live pi session is on QEST-1: session a \(pid 1\)\./,
		);
		expect(
			peersSaid("QEST-1", [
				{ id: "a", pid: 1 },
				{ id: "b", pid: 2 },
			]),
		).toMatch(/^2 other live pi sessions are on QEST-1/);
	});
});

let tmpRoot: string;
const envGuard = createEnvGuard();
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "peers-"));
});
afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("loading a quest another session is on", () => {
	it("says so in the load result", async () => {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const ctx = {
			cwd: tmpRoot,
			sessionManager: {
				getSessionId: () => "sess-here",
				isPersisted: () => true,
				getEntries: () => [],
			},
		} as unknown as Parameters<typeof handle>[2];
		const pi = { setSessionName: () => {} } as unknown as Parameters<
			typeof handle
		>[1];
		const created = succeeded(
			await handle(state, pi, ctx, { action: "create", title: "Shared" }),
		);
		const id = (created.details as { id: string }).id;
		// The runner's parent stands in for another tab: it is alive and
		// it is not this process.
		const parent = localProcessDeps().inspect(process.ppid);
		if (parent.kind !== "alive") throw new Error("parent not probeable");
		attachCurrentSession(state, {
			id: "sess-there",
			cwd: "/elsewhere",
			instanceId: "inst-there",
			process: {
				hostId: hostname(),
				pid: process.ppid,
				startToken: parent.startToken,
			},
		});
		await handle(state, pi, ctx, { action: "unload" });

		const loaded = succeeded(
			await handle(state, pi, ctx, { action: "load", id }),
		);
		expect(loaded.message).toContain(
			`Another live pi session is on ${id}: session sess-there in /elsewhere (pid ${process.ppid}).`,
		);
	});
});
