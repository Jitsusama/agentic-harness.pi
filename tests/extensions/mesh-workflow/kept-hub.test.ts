/**
 * The hub from use a peer keeps for what the mesh says by itself: found
 * at once, read without waiting, never sought under the mark or on a
 * quest heading an orchestration, and none rather than a stale one when
 * a find fails, a role is taken, the quest moves, the hub ends or its
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
		groups: ["#quest/root01/7m6jkg"],
		joined: [],
		stops: [],
		quest: "QEST-20261021-7M6JKG",
		orchestratedBy: roles.orchestratedBy,
		orchestrates: roles.orchestrates,
		questHeads: roles.questHeads,
	} as unknown as Peer;
	const asked = vi.fn(ties);
	return { at: { peer, presences, ties: asked }, asked, live };
}

/** Finds again every few milliseconds, so a test sees several. */
const QUICK: HubKeeping = { every: 5, retry: 5, spread: () => 0 };

/** No spread, so a test can count the milliseconds between finds. */
const EXACT = () => 0;

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

	// Every session asks the same node, so one that is down is asked less
	// and less often rather than by all of them every retry.
	it("waits longer after each find in a row the node gave no answer to", async () => {
		vi.useFakeTimers();
		try {
			const { at, asked } = onMesh(async () => undefined);

			keep(at, { every: NEVER_AGAIN_MS, retry: 50, spread: EXACT });

			// Asked at once, then 50, 100 and 200 ms after each miss.
			const askedBy = async (ms: number) => {
				await vi.advanceTimersByTimeAsync(ms);
				return asked.mock.calls.length;
			};
			expect(await askedBy(0)).toBe(1);
			expect(await askedBy(50)).toBe(2);
			expect(await askedBy(99)).toBe(2);
			expect(await askedBy(1)).toBe(3);
			expect(await askedBy(199)).toBe(3);
			expect(await askedBy(1)).toBe(4);
		} finally {
			vi.useRealTimers();
		}
	});

	it("waits no longer than a keeping's wait, however many finds missed", async () => {
		vi.useFakeTimers();
		try {
			const { at, asked } = onMesh(async () => undefined);

			keep(at, { every: 120, retry: 50, spread: EXACT });

			// At once, then 50 and 100 after, then 120 rather than 200.
			await vi.advanceTimersByTimeAsync(150);
			expect(asked).toHaveBeenCalledTimes(3);
			await vi.advanceTimersByTimeAsync(120);
			expect(asked).toHaveBeenCalledTimes(4);
			await vi.advanceTimersByTimeAsync(120);
			expect(asked).toHaveBeenCalledTimes(5);
		} finally {
			vi.useRealTimers();
		}
	});

	it("waits a retry again after a find that settled, not the longest it had come to", async () => {
		vi.useFakeTimers();
		try {
			let answering = false;
			const { at, asked } = onMesh(async () =>
				answering ? [tie("ROOT01", 3)] : undefined,
			);

			const hub = keep(at, { every: 100, retry: 10, spread: EXACT });

			// Misses at 0, 10 and 30; the find at 70 settles, and its hub is
			// kept for the keeping's 100 ms.
			await vi.advanceTimersByTimeAsync(69);
			expect(asked).toHaveBeenCalledTimes(3);
			answering = true;
			await vi.advanceTimersByTimeAsync(1);
			expect(asked).toHaveBeenCalledTimes(4);
			expect(hub.current()).toBe("ROOT01");
			// The node goes quiet: the find at 170 misses, and the next comes
			// a retry later at 180, not 80 later.
			answering = false;
			await vi.advanceTimersByTimeAsync(100);
			expect(asked).toHaveBeenCalledTimes(5);
			await vi.advanceTimersByTimeAsync(10);
			expect(asked).toHaveBeenCalledTimes(6);
		} finally {
			vi.useRealTimers();
		}
	});

	it("waits longer after each find in a row the node failed, as after one it gave no answer to", async () => {
		vi.useFakeTimers();
		try {
			const { at, asked } = onMesh(async () => {
				throw new Error("node down");
			});

			keep(at, { every: NEVER_AGAIN_MS, retry: 50, spread: EXACT });

			// Asked at once, then 50 and 100 ms after each failure.
			await vi.advanceTimersByTimeAsync(50);
			expect(asked).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(99);
			expect(asked).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(1);
			expect(asked).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("waits a retry again after a spell under a role, not the longest it had come to", async () => {
		vi.useFakeTimers();
		try {
			const { at, asked } = onMesh(async () => undefined);

			keep(at, { every: 1000, retry: 50, spread: EXACT });

			// Misses at 0, 50 and 150; the find at 350 sees the role and asks
			// nothing, and the next, a keeping's wait on at 1350, misses
			// again and waits a plain retry, not the 400 the misses came to.
			await vi.advanceTimersByTimeAsync(200);
			expect(asked).toHaveBeenCalledTimes(3);
			Object.assign(at.peer, { orchestrates: "7M6JKG" });
			await vi.advanceTimersByTimeAsync(200);
			Object.assign(at.peer, { orchestrates: undefined });
			await vi.advanceTimersByTimeAsync(950);
			expect(asked).toHaveBeenCalledTimes(4);
			await vi.advanceTimersByTimeAsync(50);
			expect(asked).toHaveBeenCalledTimes(5);
		} finally {
			vi.useRealTimers();
		}
	});

	// Before the peer is built there is nothing to find, which says
	// nothing of the node.
	it("counts no find toward the doubling while there is no peer to read", async () => {
		vi.useFakeTimers();
		try {
			const { at, asked } = onMesh(async () => undefined);
			let built = false;
			const hub = keepHub(() => (built ? at : undefined), {
				every: NEVER_AGAIN_MS,
				retry: 50,
				spread: EXACT,
			});
			kept.push(hub);

			// Nothing to read at 0, 50 and 100; the peer is there by 150, whose
			// find misses, and the next comes a plain retry later.
			await vi.advanceTimersByTimeAsync(120);
			built = true;
			await vi.advanceTimersByTimeAsync(30);
			expect(asked).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(50);
			expect(asked).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	// A peer whose presence isn't out yet is found nothing for without
	// asking the node, which says no more of it than having no peer does.
	it("counts no find toward the doubling while the peer has no presence", async () => {
		vi.useFakeTimers();
		try {
			const { at, asked } = onMesh(async () => undefined);
			const unpublished = {
				...at,
				peer: { ...at.peer, session: "session-unpublished" },
			};
			let published = false;
			const hub = keepHub(() => (published ? at : unpublished), {
				every: NEVER_AGAIN_MS,
				retry: 50,
				spread: EXACT,
			});
			kept.push(hub);

			// No presence at 0, 50 and 100; it is out by 150, whose find
			// misses, and the next comes a plain retry later.
			await vi.advanceTimersByTimeAsync(120);
			expect(asked).not.toHaveBeenCalled();
			published = true;
			await vi.advanceTimersByTimeAsync(30);
			expect(asked).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(50);
			expect(asked).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("lengthens each wait by up to a fifth, as the spread says", async () => {
		vi.useFakeTimers();
		try {
			const { at, asked } = onMesh(async () => undefined);

			keep(at, { every: NEVER_AGAIN_MS, retry: 50, spread: () => 1 });

			await vi.advanceTimersByTimeAsync(59);
			expect(asked).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(asked).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
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

		Object.assign(at.peer, { groups: ["#quest/other1/7m6jkg"] });

		expect(hub.current()).toBeUndefined();
	});

	// Another process can overwrite a presence file mid-session, and a
	// publish that failed leaves it stale, so the chain is read from the
	// peer itself.
	it("is found for the quest the peer is on, not the one a stale presence names", async () => {
		const { at } = onMesh(async () => [tie("ROOT01", 3)]);
		Object.assign(at.peer, { groups: ["#quest/other1/7m6jkg"] });

		const above = await aboveFor(at);

		expect(above).toMatchObject({
			none: expect.stringContaining("no live cell on a quest above it"),
		});
	});

	it("reads its stops from the peer, not from a presence that lists another", async () => {
		const { at } = onMesh(async () => [tie("ROOT01", 3)]);
		const own = at.presences.of("session-s");
		if (own === undefined) throw new Error("7M6JKG is not on the mesh");
		at.presences.publish({
			...own,
			stops: [{ address: "ROOT01", at: new Date().toISOString() }],
		});

		const above = await aboveFor(at);

		expect(above).toEqual({ address: "ROOT01", by: "use" });
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

	// A kept hub is where a send goes when the node is slow, so reading it
	// refuses whatever the find would have.
	it("is none at once when the peer stops the hub after it was found", async () => {
		const { at } = onMesh(async () => [tie("ROOT01", 3)]);
		const hub = keep(at);
		await vi.waitFor(() => expect(hub.current()).toBe("ROOT01"));

		Object.assign(at.peer, {
			stops: [{ address: "ROOT01", at: new Date().toISOString() }],
		});

		expect(hub.current()).toBeUndefined();
	});

	it("is none at once when the hub stops the peer after it was found", async () => {
		const { at } = onMesh(async () => [tie("ROOT01", 3)]);
		const hub = keep(at);
		await vi.waitFor(() => expect(hub.current()).toBe("ROOT01"));

		const root = at.presences.of("session-r");
		if (root === undefined) throw new Error("ROOT01 is not on the mesh");
		at.presences.publish({
			...root,
			stops: [{ address: "7M6JKG", at: new Date().toISOString() }],
		});

		expect(hub.current()).toBeUndefined();
	});

	// A send to an ended peer's address reaches it once it is restored,
	// and this one is on no quest above.
	it("is none at once when an ended presence on another quest lists the hub's address", async () => {
		const { at } = onMesh(async () => [tie("ROOT01", 3)]);
		const hub = keep(at);
		await vi.waitFor(() => expect(hub.current()).toBe("ROOT01"));

		at.presences.publish({
			session: "session-e",
			addresses: ["ROOT01"],
			groups: ["#quest/harn01"],
			joined: [],
			quest: "QEST-20261021-HARN01",
			worksOn: "",
			owns: [],
			busy: false,
			at: new Date().toISOString(),
			ended: new Date().toISOString(),
		});

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

	// A send's own find takes a census newer than the last find's, and a
	// hub that crashed since is gone by it though its presence never said.
	it("is none when a newer census, given to the read, judged the hub gone", async () => {
		const { at } = onMesh(async () => [tie("ROOT01", 3)]);

		const hub = keep(at);

		await vi.waitFor(() => expect(hub.current()).toBe("ROOT01"));
		expect(hub.current(["session-r"])).toBeUndefined();
		expect(hub.current(["session-x"])).toBe("ROOT01");
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
		Object.assign(at.peer, { groups: ["#quest/7m6jkg"] });

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
