/**
 * The hub from use a peer keeps for what the mesh says by itself: found
 * at once, read without waiting, never sought under the mark or on a
 * quest heading an orchestration, and none rather than a stale one when
 * a find fails, a role is taken, the hub ends or the keeping stops.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	aboveFor,
	type HubKeeping,
	type KeptHub,
	keepHub,
	keptAbove,
} from "../../../extensions/mesh-workflow/tools/above.ts";
import type { Tie } from "../../../lib/mesh/node.ts";
import type { Peer } from "../../../lib/mesh/peer.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";

const folders: string[] = [];
const kept: KeptHub[] = [];

afterEach(() => {
	for (const hub of kept.splice(0)) hub.stop();
	for (const folder of folders.splice(0)) {
		rmSync(folder, { recursive: true, force: true });
	}
});

/**
 * A tie from the peer under test to `other`, this strong, with a message
 * of its own on it today, since a tie quiet all day counts nothing.
 */
const tie = (other: string, strength: number): Tie => ({
	other,
	strength,
	hour: [0, 0],
	today: [1, 0],
	intents: [],
});

/**
 * A peer on 7M6JKG under ROOT01, with ROOT01's cell live above it, and
 * the roles given; `ties` answers as the node would.
 */
function onMesh(
	ties: () => Promise<readonly Tie[] | undefined>,
	roles: {
		orchestratedBy?: string;
		orchestrates?: string;
		questHeads?: string;
	} = {},
) {
	const folder = mkdtempSync(join(tmpdir(), "kept-hub-"));
	folders.push(folder);
	const presences = createPresences(folder);
	const live = (session: string, address: string, chain: string) =>
		presences.publish({
			session,
			addresses: [address],
			groups: [`#quest/${chain}`],
			joined: [],
			quest: `QEST-20261021-${address}`,
			worksOn: "",
			owns: [],
			busy: false,
			at: new Date().toISOString(),
		});
	live("session-s", "7M6JKG", "root01/7m6jkg");
	live("session-r", "ROOT01", "root01");
	// Only the fields finding a hub reads; the rest of a Peer is never touched.
	const peer = {
		session: "session-s",
		addresses: ["7M6JKG"],
		orchestratedBy: roles.orchestratedBy,
		orchestrates: roles.orchestrates,
		questHeads: roles.questHeads,
	} as unknown as Peer;
	const asked = vi.fn(ties);
	return { at: { peer, presences, ties: asked }, asked };
}

/** Finds again every few milliseconds, so a test sees several. */
const QUICK: HubKeeping = { every: 5, retry: 5 };

/** Long enough for a few quick finds to have come and gone. */
const A_FEW_FINDS_MS = 60;

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Keep the hub of what `at` reads, stopped after the test. */
function keep(
	at: ReturnType<typeof onMesh>["at"],
	keeping: HubKeeping = {},
): KeptHub {
	const hub = keepHub(() => at, keeping);
	kept.push(hub);
	return hub;
}

describe("a kept hub", () => {
	it("is found at once from the peer's ties, and read as reached by use", async () => {
		const { at } = onMesh(async () => [tie("ROOT01", 3)]);

		const hub = keep(at);

		await vi.waitFor(() => expect(hub.current()).toBe("ROOT01"));
		expect(keptAbove(undefined, hub)).toEqual({
			address: "ROOT01",
			by: "use",
		});
	});

	it("is never sought under the mark, which is the one reached", async () => {
		const { at, asked } = onMesh(async () => [tie("ROOT01", 3)], {
			orchestratedBy: "WCJQSG",
		});

		const hub = keep(at);
		await Promise.resolve();

		expect(asked).not.toHaveBeenCalled();
		expect(hub.current()).toBeUndefined();
		expect(keptAbove("WCJQSG", hub)).toEqual({
			address: "WCJQSG",
			by: "mark",
		});
	});

	it("is never sought by the head of an orchestration", async () => {
		const { at, asked } = onMesh(async () => [tie("ROOT01", 3)], {
			orchestrates: "7M6JKG",
		});

		const hub = keep(at);
		await Promise.resolve();

		expect(asked).not.toHaveBeenCalled();
		expect(hub.current()).toBeUndefined();
	});

	// Its quest's head is its orchestrator, so the mesh's own tells go
	// nowhere wider rather than to a hub over that head.
	it("is never sought by another session on a quest heading an orchestration", async () => {
		const { at, asked } = onMesh(async () => [tie("ROOT01", 3)], {
			questHeads: "7M6JKG",
		});

		const hub = keep(at);
		await Promise.resolve();

		expect(asked).not.toHaveBeenCalled();
		expect(hub.current()).toBeUndefined();
	});

	it("is none when the find fails, rather than one that may be gone", async () => {
		const { at, asked } = onMesh(async () => {
			throw new Error("node gone");
		});

		const hub = keep(at);

		await vi.waitFor(() => expect(asked).toHaveBeenCalled());
		await Promise.resolve();
		expect(hub.current()).toBeUndefined();
		expect(keptAbove(undefined, hub)).toBeUndefined();
	});

	it("is none once a later find fails, rather than the one found before", async () => {
		let failing = false;
		const { at } = onMesh(async () => {
			if (failing) throw new Error("node gone");
			return [tie("ROOT01", 3)];
		});

		const hub = keep(at, QUICK);
		await vi.waitFor(() => expect(hub.current()).toBe("ROOT01"));
		failing = true;

		await vi.waitFor(() => expect(hub.current()).toBeUndefined());
	});

	it("is found soon after a find that failed, not a keeping's wait later", async () => {
		let tries = 0;
		const { at } = onMesh(async () => {
			tries += 1;
			if (tries === 1) throw new Error("node not up yet");
			return [tie("ROOT01", 3)];
		});

		const hub = keep(at, { every: 60 * 60_000, retry: 5 });

		await vi.waitFor(() => expect(hub.current()).toBe("ROOT01"));
	});

	it("is none at once when the peer takes a role after it was found", async () => {
		const { at } = onMesh(async () => [tie("ROOT01", 3)]);
		const hub = keep(at);
		await vi.waitFor(() => expect(hub.current()).toBe("ROOT01"));

		Object.assign(at.peer, { orchestrates: "7M6JKG" });

		expect(hub.current()).toBeUndefined();
	});

	it("is none at once when the hub's presence says it ended", async () => {
		const { at } = onMesh(async () => [tie("ROOT01", 3)]);
		const hub = keep(at);
		await vi.waitFor(() => expect(hub.current()).toBe("ROOT01"));

		const root = at.presences.of("session-r");
		if (root === undefined) throw new Error("ROOT01 is not on the mesh");
		at.presences.publish({ ...root, ended: new Date().toISOString() });

		expect(hub.current()).toBeUndefined();
	});

	it("finds nothing more once stopped, and keeps what a find still asking comes to", async () => {
		let answer: (ties: readonly Tie[]) => void = () => undefined;
		const { at, asked } = onMesh(
			() =>
				new Promise<readonly Tie[]>((done) => {
					answer = done;
				}),
		);
		const hub = keep(at, QUICK);
		await vi.waitFor(() => expect(asked).toHaveBeenCalledOnce());

		hub.stop();
		answer([tie("ROOT01", 3)]);
		await pause(A_FEW_FINDS_MS);

		expect(asked).toHaveBeenCalledOnce();
		expect(hub.current()).toBeUndefined();
	});

	it("says once when a hub is found where none was kept", async () => {
		const { at } = onMesh(async () => [tie("ROOT01", 3)]);
		const found = vi.fn();

		keep(at, { ...QUICK, found });
		await vi.waitFor(() => expect(found).toHaveBeenCalledWith("ROOT01"));
		await pause(A_FEW_FINDS_MS);

		expect(found).toHaveBeenCalledOnce();
	});

	// Nothing above could be its hub, so ties could change nothing.
	it("asks the node nothing for a peer with no quest above it", async () => {
		const { at, asked } = onMesh(async () => [tie("ROOT01", 3)]);
		const self = at.presences.of("session-s");
		if (self === undefined) throw new Error("7M6JKG is not on the mesh");
		at.presences.publish({ ...self, groups: ["#quest/7m6jkg"] });

		const above = await aboveFor(at);

		expect(above).toMatchObject({
			none: expect.stringContaining("no quest is above it"),
		});
		expect(asked).not.toHaveBeenCalled();
	});

	it("is none with nobody above to reach", () => {
		expect(keptAbove(undefined, undefined)).toBeUndefined();
	});
});
