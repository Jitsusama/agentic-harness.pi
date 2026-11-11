/**
 * A conversation in another host closes, or is released back to plain
 * pi, through that host's socket alone.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionHost } from "../../../host/engine/index.ts";
import { hostSocketPath } from "../../../host/service/address.ts";
import { listenControl } from "../../../host/service/server.ts";
import type { TickedOwner } from "../../../lib/internal/process-ticks.ts";
import {
	closeThroughHost,
	releaseThroughHost,
} from "../../../lib/mesh/host-close.ts";

const a = "a0000000-0000-4000-8000-000000000001";
const b = "b0000000-0000-4000-8000-000000000002";

/** Who asks, as the mesh says it to the host. */
const BY = "mesh_end from AAAAAAAA";

let dir: string;
let host: SessionHost;
let closed: ReturnType<typeof vi.fn<(why: string) => void>>;
let asked: string[];
let listener: Awaited<ReturnType<typeof listenControl>> | undefined;
let answer: (sessionId: string) => unknown;
beforeEach(async () => {
	answer = (sessionId) => ({ sessionId });
	asked = [];
	dir = await mkdtemp(join(tmpdir(), "mesh-host-close-"));
	host = new SessionHost({
		key: "work-attended",
		owner: { pid: process.pid, startedAt: 1, startTicks: 7 },
		registryDir: dir,
	});
	closed = vi.fn();
	for (const id of [a, b])
		host.register({
			id,
			file: join(dir, id),
			cwd: dir,
			env: {},
			close: closed,
		});
	listener = await listenControl({
		path: hostSocketPath("work", "attended", dir),
		backend: {
			identity: { key: host.key, owner: host.owner },
			execute: async (request) => {
				if (request.op !== "close" && request.op !== "release")
					throw new Error(request.op);
				asked.push(`${request.op} by ${request.by}`);
				await host.close(request.sessionId);
				return answer(request.sessionId);
			},
		},
		report() {},
	});
});
afterEach(async () => {
	await listener?.close();
	listener = undefined;
	for (const { id } of host.list()) await host.stop(id);
	host.dispose();
	await rm(dir, { recursive: true, force: true });
});

function ownerOf(session: string, change: Partial<TickedOwner> = {}) {
	return { ...host.owner, host: host.key, session, ...change };
}

it("closes only the named conversation through its host's socket", async () => {
	expect(await closeThroughHost(ownerOf(a), BY, dir)).toBe("ended");
	expect(host.list().map((one) => one.id)).toEqual([b]);
	expect(closed).toHaveBeenCalledTimes(1);
	expect(asked, "the host hears who asked for the close").toEqual([
		`close by ${BY}`,
	]);
});

it("cuts a long asker to what the host's protocol takes, rather than be refused", async () => {
	expect(await closeThroughHost(ownerOf(a), "x".repeat(200), dir)).toBe(
		"ended",
	);
	expect(asked, "the host hears 128 characters of who asked").toEqual([
		`close by ${"x".repeat(128)}`,
	]);
});

it("releases only the named conversation, asking its host for a release", async () => {
	expect(await releaseThroughHost(ownerOf(a), BY, dir)).toBe("ended");
	expect(asked, "the host hears who asked for the release").toEqual([
		`release by ${BY}`,
	]);
	expect(host.list().map((one) => one.id)).toEqual([b]);
});

it("leaves a conversation alone when the socket answers for another process", async () => {
	expect(await closeThroughHost(ownerOf(a, { startTicks: 8 }), BY, dir)).toBe(
		"unsure",
	);
	expect(
		await closeThroughHost(ownerOf(a, { pid: process.pid + 1 }), BY, dir),
	).toBe("unsure");
	expect(host.list()).toHaveLength(2);
	expect(closed).not.toHaveBeenCalled();
});

it("is unsure when the host's yes does not name the conversation", async () => {
	answer = () => undefined;
	expect(await closeThroughHost(ownerOf(a), BY, dir)).toBe("unsure");
	answer = () => ({ sessionId: b });
	expect(await closeThroughHost(ownerOf(b), BY, dir)).toBe("ended");
	answer = () => ({ sessionId: a });
	expect(await closeThroughHost(ownerOf(b), BY, dir)).toBe("unsure");
});

it("is unsure, never closing anything, when no socket can be named or reached", async () => {
	expect(
		await closeThroughHost(ownerOf(a, { host: "test-host" }), BY, dir),
	).toBe("unsure");
	expect(
		await closeThroughHost(ownerOf(a, { host: "home-background" }), BY, dir),
	).toBe("unsure");
	expect(await closeThroughHost(ownerOf("not-a-uuid"), BY, dir)).toBe("unsure");
	expect(await closeThroughHost(ownerOf(a), BY, "relative")).toBe("unsure");
	expect(host.list()).toHaveLength(2);
});
