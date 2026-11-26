/**
 * A peer joins no group past the most a presence names, nor one longer
 * than a group runs, whichever way it is brought in: mesh_join, a send
 * to a group, or another peer's invite all join through it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MOST_GROUP_CHARS } from "../../../lib/mesh/group.ts";
import { localPeer } from "../../../lib/mesh/peer.ts";
import {
	createPresences,
	joinRefused,
	MOST_GROUPS,
} from "../../../lib/mesh/presence.ts";

let root: string;
const session = "01a1be5c-fff0-70a1-9301-f505d5634bf7";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-join-cap-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A peer with a presence folder of its own. */
function aPeer() {
	const presences = createPresences(join(root, "presence"));
	const peer = localPeer({
		session,
		cwd: root,
		records: { sessions: join(root, "sessions"), quests: join(root, "quests") },
		presences,
		owner: { pid: 4300, startedAt: 1_794_370_632_830, startTicks: 14_107_285 },
	});
	return { peer, presences };
}

/**
 * Joins groups until the peer is in `MOST_GROUPS`, giving up after twice
 * as many tries, so a join that never counts fails here, not by hanging.
 */
function fill(peer: ReturnType<typeof aPeer>["peer"]): void {
	for (
		let at = 0;
		peer.groups.length < MOST_GROUPS && at < MOST_GROUPS * 2;
		at += 1
	) {
		peer.join(`#group-${String(at).padStart(3, "0")}`);
	}
	expect(peer.groups, "the peer filled up").toHaveLength(MOST_GROUPS);
}

describe("a peer joining past what a presence names", () => {
	it("joins no group once it is in the most a peer may be in", () => {
		const { peer, presences } = aPeer();
		fill(peer);

		expect(peer.join("#zzz-one-more"), "the join is refused").toBe(false);
		expect(peer.joined).not.toContain("#zzz-one-more");
		expect(presences.of(session)?.joined, "nothing past it is written").toEqual(
			peer.joined,
		);
	});

	// Peer.join answers a group it is in before it asks the rule, so the
	// rule's own clause for one is pinned here, where nothing hides it.
	it("refuses no group a full peer is already in", () => {
		const groups = Array.from(
			{ length: MOST_GROUPS },
			(_, at) => `#group-${String(at).padStart(3, "0")}`,
		);

		expect(joinRefused(groups, "#group-000")).toBeUndefined();
		expect(joinRefused(groups, "#zzz-one-more")).toBe("full");
	});

	// A peer in #group-000 hears what is sent to #group, so a full peer
	// is not told to make room to join a group it hears already.
	it("says a full peer hears a group it is in a part of, joining it to nothing", () => {
		const { peer } = aPeer();
		const groups = Array.from(
			{ length: MOST_GROUPS },
			(_, at) => `#group-${String(at).padStart(3, "0")}`,
		);

		expect(joinRefused([...groups.slice(1), "#group/part"], "#group")).toBe(
			"heard",
		);
		fill(peer);
		peer.leave("#group-000");
		peer.join("#group/part");
		expect(peer.join("#group"), "the join is refused").toBe(false);
		expect(peer.joined).not.toContain("#group");
	});

	it("joins no group longer than a group runs", () => {
		const { peer } = aPeer();
		const long = `#${"a".repeat(MOST_GROUP_CHARS)}`;

		expect(peer.join(long), "the join is refused").toBe(false);
		expect(peer.joined).not.toContain(long);
	});

	it("joins again once it has left one", () => {
		const { peer } = aPeer();
		fill(peer);
		const [first] = peer.joined;
		if (first === undefined) throw new Error("the peer joined nothing");
		peer.leave(first);

		expect(
			peer.join("#zzz-one-more"),
			"the join is taken once a group is left",
		).toBe(true);
	});
});
