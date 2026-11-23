/**
 * The hub from use a peer keeps for what the mesh says by itself: found
 * at once, read without waiting, never sought under the mark or on a
 * quest heading an orchestration, kept through a find that fails or gets
 * no answer, and none once a find finishes finding none, a role is
 * taken, the quest moves, the hub ends, either stops the other or its
 * address is shared, or the keeping stops.
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
	return { at: { peer, presences, ties: asked }, asked, live };
}

/** Finds again every few milliseconds, so a test sees several. */
const QUICK: HubKeeping = { every: 5, retry: 5 };

/** Long enough for a few quick finds to have come and gone. */
const A_FEW_FINDS_MS = 60;

/** Long enough that no find in a test comes round again by itself. */
const NEVER_AGAIN_MS = 60 * 60_000;

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

		const hub = keep(at, QUICK);
		// Long enough for any find it made to have asked the node.
		await pause(A_FEW_FINDS_MS);

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

		const hub = keep(at, QUICK);
		// Long enough for any find it made to have asked the node.
		await pause(A_FEW_FINDS_MS);

		expect(asked).not.toHaveBeenCalled();
		expect(hub.current()).toBeUndefined();
	});

	// Its quest's head is its orchestrator, so the mesh's own tells go
	// nowhere wider rather than to a hub over that head.
	it("is never sought by another session on a quest heading an orchestration", async () => {
		const { at, asked } = onMesh(async () => [tie("ROOT01", 3)], {
			questHeads: "7M6JKG",
		});

		const hub = keep(at, QUICK);
		// Long enough for any find it made to have asked the node.
		await pause(A_FEW_FINDS_MS);

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

	// The node going quiet says nothing about who is above, and dropping
	// the hub then would send every unmarked session's questions to the
	// person just as need stops finding owners too.
	it("keeps the hub found before while later finds fail, unsaid", async () => {
		let failing = false;
		const { at, asked } = onMesh(async () => {
			if (failing) throw new Error("node gone");
			return [tie("ROOT01", 3)];
		});
		const found = vi.fn();
		const hub = keep(at, { ...QUICK, found });
		await vi.waitFor(() => expect(hub.current()).toBe("ROOT01"));
		failing = true;
		const before = asked.mock.calls.length;
		await vi.waitFor(() =>
			expect(asked.mock.calls.length).toBeGreaterThan(before + 2),
		);
		const said = found.mock.calls.length;
		const failedSince = asked.mock.calls.length;
		await vi.waitFor(() =>
			expect(asked.mock.calls.length).toBeGreaterThan(failedSince + 2),
		);

		expect(hub.current()).toBe("ROOT01");
		expect(found, "a failed find says no hub").toHaveBeenCalledTimes(said);
	});

	it("keeps the hub found before while the node gives no ties", async () => {
		let quiet = false;
		const { at, asked } = onMesh(async () =>
			quiet ? undefined : [tie("ROOT01", 3)],
		);
		const found = vi.fn();
		const hub = keep(at, { ...QUICK, found });
		await vi.waitFor(() => expect(hub.current()).toBe("ROOT01"));
		quiet = true;
		const before = asked.mock.calls.length;
		await vi.waitFor(() =>
			expect(asked.mock.calls.length).toBeGreaterThan(before + 2),
		);
		const said = found.mock.calls.length;
		const quietSince = asked.mock.calls.length;
		await vi.waitFor(() =>
			expect(asked.mock.calls.length).toBeGreaterThan(quietSince + 2),
		);

		expect(hub.current()).toBe("ROOT01");
		expect(found, "an unanswered find says no hub").toHaveBeenCalledTimes(said);
	});

	// While the node is quiet the kept hub meets no find, so reading it
	// holds to the stops the find would have refused it on.
	for (const [who, stopper, stopped] of [
		["this peer stops the hub", "session-s", "ROOT01"],
		["the hub stops this peer", "session-r", "7M6JKG"],
	] as const) {
		it(`is none at once, the node quiet, when ${who}`, async () => {
			let quiet = false;
			const { at, asked } = onMesh(async () =>
				quiet ? undefined : [tie("ROOT01", 3)],
			);
			const hub = keep(at, QUICK);
			await vi.waitFor(() => expect(hub.current()).toBe("ROOT01"));
			quiet = true;
			const before = asked.mock.calls.length;
			await vi.waitFor(() =>
				expect(asked.mock.calls.length).toBeGreaterThan(before + 1),
			);

			const one = at.presences.of(stopper);
			if (one === undefined) throw new Error(`${stopper} is not on the mesh`);
			at.presences.publish({
				...one,
				stops: [{ address: stopped, at: new Date().toISOString() }],
			});

			expect(hub.current()).toBeUndefined();
		});
	}

	it("is none once a later find finishes and finds none", async () => {
		let tied = true;
		const { at } = onMesh(async () => (tied ? [tie("ROOT01", 3)] : []));
		const hub = keep(at, QUICK);
		await vi.waitFor(() => expect(hub.current()).toBe("ROOT01"));
		tied = false;

		await vi.waitFor(() => expect(hub.current()).toBeUndefined());
	});

	it("is found soon after a find that failed, not a keeping's wait later", async () => {
		let tries = 0;
		const { at } = onMesh(async () => {
			tries += 1;
			if (tries === 1) throw new Error("node not up yet");
			return [tie("ROOT01", 3)];
		});

		const hub = keep(at, { every: NEVER_AGAIN_MS, retry: 5 });

		await vi.waitFor(() => expect(hub.current()).toBe("ROOT01"));
	});

	it("is found soon after a find the node gave no answer to", async () => {
		let tries = 0;
		const { at } = onMesh(async () => {
			tries += 1;
			return tries === 1 ? undefined : [tie("ROOT01", 3)];
		});

		const hub = keep(at, { every: NEVER_AGAIN_MS, retry: 5 });

		await vi.waitFor(() => expect(hub.current()).toBe("ROOT01"));
	});

	it("is none at once when the peer takes a role after it was found", async () => {
		const { at } = onMesh(async () => [tie("ROOT01", 3)]);
		const hub = keep(at);
		await vi.waitFor(() => expect(hub.current()).toBe("ROOT01"));

		Object.assign(at.peer, { orchestrates: "7M6JKG" });

		expect(hub.current()).toBeUndefined();
	});

	it("is none at once when the peer's quest moves out from under the hub", async () => {
		const { at } = onMesh(async () => [tie("ROOT01", 3)]);
		const hub = keep(at);
		await vi.waitFor(() => expect(hub.current()).toBe("ROOT01"));

		const self = at.presences.of("session-s");
		if (self === undefined) throw new Error("7M6JKG is not on the mesh");
		at.presences.publish({ ...self, groups: ["#quest/other1/7m6jkg"] });

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

	// The find refuses an address two live presences list, since a forged
	// one could point a send elsewhere; reading the kept hub holds to it.
	it("is none at once when a second live presence lists the hub's address", async () => {
		const { at, live } = onMesh(async () => [tie("ROOT01", 3)]);
		const hub = keep(at);
		await vi.waitFor(() => expect(hub.current()).toBe("ROOT01"));

		live("session-x", "ROOT01", "root01");

		expect(hub.current()).toBeUndefined();
	});

	// A crashed session never says it ended, and its quest's next session
	// signs with the same address: the find's census judges the dead one
	// gone, and reading the kept hub holds to that judgment.
	it("stays the hub when a dead session the find judged gone still lists its address", async () => {
		const { at } = onMesh(async () => [tie("ROOT01", 3)]);
		at.presences.publish({
			session: "session-d",
			addresses: ["ROOT01"],
			groups: ["#quest/root01"],
			joined: [],
			quest: "QEST-20261021-ROOT01",
			worksOn: "",
			owns: [],
			busy: false,
			// This process under another start, so the census reads it gone.
			owner: { pid: process.pid, startedAt: 1 },
			at: new Date().toISOString(),
		});

		const hub = keep(at);

		await vi.waitFor(() => expect(hub.current()).toBe("ROOT01"));
	});

	it("finds nothing more once stopped, and keeps nothing a find still asking comes to", async () => {
		let answer: (ties: readonly Tie[]) => void = () => undefined;
		const { at, asked } = onMesh(
			() =>
				new Promise<readonly Tie[]>((done) => {
					answer = done;
				}),
		);
		const found = vi.fn();
		const hub = keep(at, { ...QUICK, found });
		await vi.waitFor(() => expect(asked).toHaveBeenCalledOnce());

		hub.stop();
		answer([tie("ROOT01", 3)]);
		// Long enough for the late find to have kept and said its hub, and
		// for more to have come round, had stopping not held them.
		await pause(A_FEW_FINDS_MS);

		expect(asked).toHaveBeenCalledOnce();
		expect(found).not.toHaveBeenCalled();
		expect(hub.current()).toBeUndefined();
	});

	// What waited for a hub is told even when the one found is the hub
	// kept before, or another, after a spell reading as none.
	it("says each find that keeps a hub, not only the first", async () => {
		const { at } = onMesh(async () => [tie("ROOT01", 3)]);
		const found = vi.fn();

		keep(at, { ...QUICK, found });

		await vi.waitFor(() =>
			expect(found.mock.calls.length).toBeGreaterThanOrEqual(3),
		);
		expect(found).toHaveBeenCalledWith("ROOT01");
	});

	it("keeps the hub it found when whoever hears of it fails", async () => {
		const { at } = onMesh(async () => [tie("ROOT01", 3)]);
		const found = vi.fn(() => {
			throw new Error("the tell failed");
		});

		const hub = keep(at, { ...QUICK, found });
		await vi.waitFor(() => expect(found).toHaveBeenCalled());

		expect(hub.current()).toBe("ROOT01");
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
