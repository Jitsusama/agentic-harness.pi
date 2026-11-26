/**
 * A peer joins no group past the most a presence names, nor one longer
 * than a group runs, whichever way it is brought in: mesh_join, a send
 * to a group, or another peer's invite all join through it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	groupsText,
	join as joinTool,
} from "../../../extensions/mesh-workflow/tools/groups.ts";
import { MOST_GROUP_CHARS } from "../../../lib/mesh/group.ts";
import { createBoard } from "../../../lib/mesh/lease.ts";
import { localPeer } from "../../../lib/mesh/peer.ts";
import {
	createPresences,
	joinedWithin,
	joinRefused,
	MOST_GROUPS,
	roomToBringBack,
	roomToJoin,
} from "../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";

let root: string;
const session = "01a1be5c-fff0-70a1-9301-f505d5634bf7";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-join-cap-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A peer with a presence folder of its own, told what it sets aside. */
function aPeer(onSetAside?: (groups: readonly string[]) => void) {
	const presences = createPresences(join(root, "presence"));
	const peer = localPeer({
		...(onSetAside ? { onSetAside } : {}),
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
 * Answers the joined group that sorts last, the first a scope sets
 * aside, found rather than named, since a temporary folder inside a
 * checkout brings a scope of its own (#2243's fourth council, F10).
 */
function fill(peer: ReturnType<typeof aPeer>["peer"]): string {
	for (
		let at = 0;
		peer.groups.length < MOST_GROUPS && at < MOST_GROUPS * 2;
		at += 1
	) {
		peer.join(`#group-${String(at).padStart(3, "0")}`);
	}
	expect(peer.groups, "the peer filled up").toHaveLength(MOST_GROUPS);
	const last = peer.joined.at(-1);
	if (last === undefined) throw new Error("the peer joined nothing");
	return last;
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
		const last = fill(peer);
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
		expect(peer.setAside, "the last set aside").toEqual([last]);
		expect(peer.groups).not.toContain(last);
		expect(aPeer().peer.setAside, "through a reload").toEqual([last]);
		const listed = groupsText(
			{ present: [], gone: [], resuming: [] },
			peer,
			[],
		);
		expect(listed, "mesh_groups names it").toContain(
			`It set aside ${last}, which it joined`,
		);
		expect(listed, "not as joined").not.toMatch(
			new RegExp(`has joined [^;]*${last}`),
		);

		rmSync(join(root, "sessions", `${session}.json`));
		peer.refresh();

		expect(peer.groups, "back once the scope goes").toContain(last);
		expect(peer.setAside).toEqual([]);
	});

	// A need routed by what a peer owns would reach it for a group it no
	// longer hears (#2243's fourth council, F20).
	it("owns no joined group it set aside", () => {
		const { peer, presences } = aPeer();
		const last = fill(peer);
		loadQuest();

		peer.refresh();

		const [first = ""] = peer.joined;
		expect(peer.receiver.owns, "a group in force").toContain(first.slice(1));
		expect(peer.receiver.owns, "not one set aside").not.toContain(
			last.slice(1),
		);
		expect(presences.of(session)?.owns, "as published").toEqual(
			peer.receiver.owns,
		);
	});

	// A join's own refresh may bring a scope that leaves it no room.
	it("says a join it had to set aside at once did not join", () => {
		const { peer } = aPeer();
		peer.leave(fill(peer));
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

	// A refresh in the background is asked by no tool, so nothing else
	// would tell the session it stopped hearing a group (#2243's fourth
	// council, F17).
	it("tells the session once of a group a refresh sets aside", () => {
		const told: string[][] = [];
		const { peer } = aPeer((groups) => told.push([...groups]));
		const last = fill(peer);
		loadQuest();

		peer.refresh();
		peer.refresh();

		expect(told, "told once, naming it").toEqual([[last]]);
		const again: string[][] = [];
		aPeer((groups) => again.push([...groups]));
		expect(again, "not told again as a reload starts").toEqual([]);
	});

	it("leaves the telling of a group its own join sets aside to the join", () => {
		const told: string[][] = [];
		const { peer } = aPeer((groups) => told.push([...groups]));
		peer.leave(fill(peer));
		loadQuest();

		expect(peer.join("#zzz-last"), "not in force").toBe(false);
		expect(told).toEqual([]);
	});

	// mesh_join refreshes before it joins, so a scope landing between the
	// two sets the join aside at once (#2243's fourth council, F1).
	it("has mesh_join say a join it set aside at once is not heard yet", async () => {
		const { peer, presences } = aPeer();
		peer.leave(fill(peer));
		loadQuest();

		const answer = await joinTool(
			{
				peer,
				presences,
				transport: folderTransport(join(root, "messages")),
				board: createBoard(join(root, "leases")),
				sent: () => {},
			},
			{ group: "#zzz-last" },
		);

		const text = answer.content[0]?.text ?? "";
		expect(text).toContain(
			"Joined #zzz-last, but set it aside at once, so it hears nothing there yet.",
		);
		expect(text).not.toContain("In #zzz-last.");
		expect(text, "and why").toContain(
			"It set aside #zzz-last, which it joined",
		);
	});

	// Each leave gives its room to the set-aside group that sorts first,
	// so one leave makes no room for a join (#2243's fourth council, F2).
	it("says a full peer holding groups aside must leave one more than it holds", () => {
		const { peer } = aPeer();
		fill(peer);
		loadQuest();
		peer.refresh();
		expect(roomToJoin(peer.setAside)).toContain("leave 2 of the groups");

		peer.leave("#group-000");
		expect(peer.join("#zzz-one-more"), "the set-aside one took the room").toBe(
			false,
		);
		peer.leave("#group-001");
		expect(peer.join("#zzz-one-more"), "the second leave makes room").toBe(
			true,
		);
	});

	it("names at most three groups it holds aside, counting the rest", () => {
		const aside = ["#a", "#b", "#c", "#d", "#e"];

		expect(roomToJoin(aside)).toContain("(#a, #b, #c and 2 more)");
		expect(roomToJoin(aside)).toContain("leave 6 of the groups");
		expect(roomToJoin([])).toBe(
			"leave one it no longer works on with mesh_leave",
		);
	});

	// The rest of #2243's fifth council.

	// A join sorting before the groups it holds keeps its room, and the
	// refresh it brings sets aside another, which nothing else says (F4).
	it("tells the session of another group a join's own refresh sets aside", () => {
		const told: string[][] = [];
		const { peer } = aPeer((groups) => told.push([...groups]));
		peer.leave(fill(peer));
		const before = peer.joined.at(-1);
		loadQuest();

		expect(peer.join("#aaa"), "in force").toBe(true);
		expect(peer.groups).toContain("#aaa");
		expect(peer.setAside, "the last before it").toEqual([before]);
		expect(told, "told of that one").toEqual([[before]]);
	});

	// A quest loaded while the session was down sets a group aside at its
	// first refresh, which nothing told it of before (F13 and F21).
	it("tells a session starting of a group set aside since its last presence", () => {
		const last = fill(aPeer().peer);
		loadQuest();

		const told: string[][] = [];
		aPeer((groups) => told.push([...groups]));

		expect(told, "told as it starts").toEqual([[last]]);
	});

	// A stale pi throws as a reload replaces it (F1 and F20).
	it("tells a group again at the next refresh when the telling threw", () => {
		const told: string[][] = [];
		let throws = true;
		const { peer } = aPeer((groups) => {
			if (throws) throw new Error("a stale pi");
			told.push([...groups]);
		});
		const last = fill(peer);
		loadQuest();

		expect(() => peer.refresh(), "the refresh stands").not.toThrow();
		expect(peer.groups, "and brought its scope").toContain("#quest/luq49e");
		throws = false;
		peer.refresh();

		expect(told, "told at the next").toEqual([[last]]);
	});

	// Already joined, a set-aside group waits its turn: refused as full,
	// it would be told to leave more than it needs (F14).
	it("has mesh_join say a group it joined and set aside waits for room", async () => {
		const { peer, presences } = aPeer();
		const last = fill(peer);
		loadQuest();
		peer.refresh();

		const answer = await joinTool(
			{
				peer,
				presences,
				transport: folderTransport(join(root, "messages")),
				board: createBoard(join(root, "leases")),
				sent: () => {},
			},
			{ group: last },
		);

		const text = answer.content[0]?.text ?? "";
		expect(text).toContain(`Already joined ${last}, but set aside`);
		expect(text, "one leave brings it back").toContain(
			"leave one of the groups",
		);
		expect(text).not.toContain("Not in");
	});

	it("counts the leaves that bring a set-aside group back by its place", () => {
		const aside = ["#a", "#b", "#c"];

		expect(roomToBringBack(aside, "#a")).toContain("leave one of the groups");
		expect(roomToBringBack(aside, "#c")).toContain("leave 3 of the groups");
	});
});
