/**
 * A peer joins no group past the most a presence names, nor one longer
 * than a group runs, whichever way it is brought in: mesh_join, a send
 * to a group, or another peer's invite all join through it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { groupsText } from "../../../extensions/mesh-workflow/tools/groups.ts";
import { MOST_GROUP_CHARS } from "../../../lib/mesh/group.ts";
import { localPeer } from "../../../lib/mesh/peer.ts";
import {
	createPresences,
	joinedWithin,
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

/** Puts this session on a quest, whose scope its next refresh brings. */
function loadQuest(): void {
	const quest = "QEST-20261021-LUQ49E";
	mkdirSync(join(root, "sessions"), { recursive: true });
	writeFileSync(
		join(root, "sessions", `${session}.json`),
		JSON.stringify({ quest }),
	);
	mkdirSync(join(root, "quests", quest), { recursive: true });
	writeFileSync(
		join(root, "quests", quest, "README.md"),
		`---\nid: ${quest}\nkind: quest\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\n---\n# A Stable Substrate\n\n## 📜 Summary\n\nGrow the mesh.\n`,
	);
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

	// A quest loaded or a tree gained adds a scope at the next refresh,
	// which no join is asked about, so a full peer would name one past
	// the most and its presence would drop whatever sorted last, as
	// often its quest's scope (#2217's third council). The joined group
	// it sets aside for it stays its choice, through a reload, and comes
	// back once the scope goes (#2243's first council, G).
	it("keeps the scope a refresh brings a full peer, setting a joined group aside for it", () => {
		const { peer, presences } = aPeer();
		fill(peer);
		const chosen = [...peer.joined];
		loadQuest();

		peer.refresh();

		const said = presences.of(session);
		expect(peer.groups, "its quest's scope").toContain("#quest/luq49e");
		expect(peer.groups, "no more than a presence names").toHaveLength(
			MOST_GROUPS,
		);
		expect(said?.groups, "as published").toEqual(peer.groups);
		expect(peer.joined, "still its choice").toEqual(chosen);
		expect(said?.joined, "as published").toEqual(chosen);
		expect(peer.setAside, "the last set aside").toEqual(["#group-063"]);
		expect(peer.groups).not.toContain("#group-063");
		expect(aPeer().peer.setAside, "through a reload").toEqual(["#group-063"]);
		const listed = groupsText(
			{ present: [], gone: [], resuming: [] },
			peer,
			[],
		);
		expect(listed, "mesh_groups names it").toContain(
			"It set aside #group-063, which it joined",
		);
		expect(listed, "not as joined").not.toMatch(/has joined [^;]*#group-063/);

		rmSync(join(root, "sessions", `${session}.json`));
		peer.refresh();

		expect(peer.groups, "back once the scope goes").toContain("#group-063");
		expect(peer.setAside).toEqual([]);
	});

	// A join's own refresh may bring a scope that leaves it no room.
	it("says a join it had to set aside at once did not join", () => {
		const { peer } = aPeer();
		fill(peer);
		peer.leave("#group-063");
		loadQuest();

		expect(peer.join("#zzz-last"), "not in force").toBe(false);
		expect(peer.groups).toContain("#quest/luq49e");
		expect(peer.setAside).toEqual(["#zzz-last"]);
	});

	it("lets a joined group that is also a scope cost no room", () => {
		const joined = Array.from(
			{ length: MOST_GROUPS },
			(_, at) => `#group-${String(at).padStart(3, "0")}`,
		);

		expect(joinedWithin(["#group-000"], joined)).toEqual(joined);
		expect(joinedWithin(["#quest/a", "#repo/b"], joined)).toEqual(
			joined.slice(0, MOST_GROUPS - 2),
		);
		expect(joinedWithin(joined, ["#zzz"])).toEqual([]);
	});

	it("joins again once it has left one", () => {
		const { peer } = aPeer();
		fill(peer);
		const [first] = peer.joined;
		if (first === undefined) throw new Error("the peer joined nothing");
		peer.leave(first);

		expect(
			peer.join("#zzz-one-more"),
			"a join fits once a leave frees its place",
		).toBe(true);
	});
});
