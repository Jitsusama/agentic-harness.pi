/** A conversation in another host closes through that host's socket alone. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionHost } from "../../../host/engine/index.ts";
import { hostSocketPath } from "../../../host/service/address.ts";
import { listenControl } from "../../../host/service/server.ts";
import type { TickedOwner } from "../../../lib/internal/process-ticks.ts";
import { closeThroughHost } from "../../../lib/mesh/host-close.ts";

const a = "a0000000-0000-4000-8000-000000000001";
const b = "b0000000-0000-4000-8000-000000000002";

let dir: string;
let host: SessionHost;
let closed: ReturnType<typeof vi.fn<(why: string) => void>>;
let listener: Awaited<ReturnType<typeof listenControl>> | undefined;
beforeEach(async () => {
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
				if (request.op !== "close") throw new Error(request.op);
				await host.close(request.sessionId);
				return { sessionId: request.sessionId };
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
	expect(await closeThroughHost(ownerOf(a), dir)).toBe("ended");
	expect(host.list().map((one) => one.id)).toEqual([b]);
	expect(closed).toHaveBeenCalledTimes(1);
});

it("leaves a conversation alone when the socket answers for another process", async () => {
	expect(await closeThroughHost(ownerOf(a, { startTicks: 8 }), dir)).toBe(
		"unsure",
	);
	expect(
		await closeThroughHost(ownerOf(a, { pid: process.pid + 1 }), dir),
	).toBe("unsure");
	expect(host.list()).toHaveLength(2);
	expect(closed).not.toHaveBeenCalled();
});

it("is unsure, never closing anything, when no socket can be named or reached", async () => {
	expect(await closeThroughHost(ownerOf(a, { host: "test-host" }), dir)).toBe(
		"unsure",
	);
	expect(
		await closeThroughHost(ownerOf(a, { host: "home-background" }), dir),
	).toBe("unsure");
	expect(await closeThroughHost(ownerOf("not-a-uuid"), dir)).toBe("unsure");
	expect(await closeThroughHost(ownerOf(a), "relative")).toBe("unsure");
	expect(host.list()).toHaveLength(2);
});
