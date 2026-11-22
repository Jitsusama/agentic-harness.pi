/**
 * A cell's hub from use: where `orchestrator` reaches when its quest
 * carries no mark, read from its ties to the live cells on the quests
 * above its own.
 */

import { describe, expect, it } from "vitest";
import { hubFromUse } from "../../../lib/mesh/hub-from-use.ts";
import type { Tie } from "../../../lib/mesh/node.ts";
import type { Presence } from "../../../lib/mesh/presence.ts";

/** A live cell with these addresses, on the quest chain given, root first. */
function cell(
	session: string,
	addresses: string[],
	chain: string[],
	extra: Partial<Presence> = {},
): Presence {
	return {
		session,
		addresses,
		groups: chain.length > 0 ? [`#quest/${chain.join("/")}`, "#harness"] : [],
		joined: ["#harness"],
		...(chain.length > 0
			? { quest: `QEST-20261021-${chain.at(-1)?.toUpperCase()}` }
			: {}),
		worksOn: "",
		owns: [],
		busy: false,
		at: new Date(0).toISOString(),
		...extra,
	};
}

/**
 * A tie from the cell under test to `other`, this strong, every one of
 * today's messages on it the cell's own, so it counts whole.
 */
const tie = (other: string, strength: number): Tie => ({
	other,
	strength,
	hour: [0, 0],
	today: [1, 0],
	intents: [],
});

const self = cell("s", ["7M6JKG"], ["root01", "mid002", "7m6jkg"]);
const parent = cell("p", ["MID002", "AAAAAA"], ["root01", "mid002"]);
const root = cell("r", ["ROOT01"], ["root01"]);
const sibling = cell("b", ["SIB003"], ["root01", "mid002", "sib003"]);

describe("a hub from use", () => {
	it("is the live cell above this one's quest that its strongest tie goes to", () => {
		const above = hubFromUse(
			self,
			[self, parent, root, sibling],
			[tie("SIB003", 9), tie("ROOT01", 5), tie("MID002", 2)],
		);

		expect(above).toEqual({ address: "ROOT01", by: "use" });
	});

	it("is reached by the address it signs with, whichever one the tie names", () => {
		const above = hubFromUse(self, [self, parent], [tie("AAAAAA", 1)]);

		expect(above).toEqual({ address: "MID002", by: "use" });
	});

	it("is never a cell on this one's own quest or below it, however tied", () => {
		const twin = cell("t", ["TWIN04"], ["root01", "mid002", "7m6jkg"]);
		const child = cell(
			"c",
			["KID005"],
			["root01", "mid002", "7m6jkg", "kid005"],
		);

		const above = hubFromUse(
			self,
			[self, twin, child],
			[tie("TWIN04", 9), tie("KID005", 8)],
		);

		expect(above).toMatchObject({
			none: expect.stringContaining("no live cell on a quest above it"),
		});
	});

	it("passes over a cell that has stopped this one", () => {
		const stopper = cell("r", ["ROOT01"], ["root01"], {
			stops: [{ address: "7M6JKG", at: new Date(0).toISOString() }],
		});

		const above = hubFromUse(
			self,
			[self, stopper, parent],
			[tie("ROOT01", 9), tie("MID002", 1)],
		);

		expect(above).toEqual({ address: "MID002", by: "use" });
	});

	// Its answer would be dropped as it arrives, so the question would
	// wait on nobody.
	it("passes over a cell this one has stopped, by address or by session", () => {
		const at = new Date(0).toISOString();
		const byAddress = { ...self, stops: [{ address: "ROOT01", at }] };
		const bySession = {
			...self,
			stops: [{ address: "OLD999", session: "r", at }],
		};
		const ties = [tie("ROOT01", 9), tie("MID002", 1)];

		expect(hubFromUse(byAddress, [byAddress, root, parent], ties)).toEqual({
			address: "MID002",
			by: "use",
		});
		expect(hubFromUse(bySession, [bySession, root, parent], ties)).toEqual({
			address: "MID002",
			by: "use",
		});
	});

	// Strength counts both ends' messages, so without the share a cell
	// above that only writes at this one would win.
	it("counts a tie for this cell's own share of today's messages on it", () => {
		const talkedAt = { ...tie("ROOT01", 9), today: [0, 9] as const };
		const talkedTo = { ...tie("MID002", 2), today: [2, 0] as const };

		const above = hubFromUse(self, [self, root, parent], [talkedAt, talkedTo]);

		expect(above).toEqual({ address: "MID002", by: "use" });
	});

	it("is nobody when the only cell tied above has only written at this one today", () => {
		const talkedAt = { ...tie("ROOT01", 9), today: [0, 9] as const };

		const above = hubFromUse(self, [self, root], [talkedAt]);

		expect(above).toEqual({
			none: expect.stringContaining(
				"no live cell on a quest above it has a tie",
			),
		});
	});

	// A tie halves every two hours, so one message sent 20 hours ago
	// reads about 0.001: a cell this one barely knows, not one it talks
	// with most.
	it("is nobody when the only tie above has faded below one message six hours old", () => {
		const faded = tie("ROOT01", 2 ** -10);

		const above = hubFromUse(self, [self, root], [faded]);

		expect(above).toEqual({
			none: expect.stringContaining("too faint"),
		});
	});

	// A quiet afternoon mustn't lose the hub: one message of its own six
	// hours old is the floor, and is enough.
	it("is the cell tied above by one message of this cell's own six hours old", () => {
		const quietAfternoon = tie("ROOT01", 2 ** -3);

		const above = hubFromUse(self, [self, root], [quietAfternoon]);

		expect(above).toEqual({ address: "ROOT01", by: "use" });
	});

	it("weighs the floor against a cell's ties to all its addresses added up", () => {
		const above = hubFromUse(
			self,
			[self, parent],
			[tie("MID002", 2 ** -4), tie("AAAAAA", 2 ** -4)],
		);

		expect(above).toEqual({ address: "MID002", by: "use" });
	});

	// The node keeps no tie without a message in the last day, so one
	// that reads none can't say whose talk it was.
	it("is nobody when the only tie above reads no messages today", () => {
		const quiet = { ...tie("ROOT01", 9), today: [0, 0] as const };

		const above = hubFromUse(self, [self, root], [quiet]);

		expect(above).toEqual({
			none: expect.stringContaining(
				"no live cell on a quest above it has a tie",
			),
		});
	});

	// A send reads an address in any case as the one peer, so a forged
	// presence spelling another's address otherwise would reach it.
	it("is never reached at an address another live presence lists in another case", () => {
		const forged = cell("f", ["harn01"], ["root01"]);
		const harness = cell("h", ["HARN01"], ["harn01"]);

		const above = hubFromUse(
			self,
			[self, forged, harness, parent],
			[tie("harn01", 9), tie("MID002", 1)],
		);

		expect(above).toEqual({ address: "MID002", by: "use" });
	});

	it("credits a cell with no tie to a group name it lists", () => {
		const mixed = cell("m", ["#all", "ROOT01"], ["root01"]);

		const above = hubFromUse(
			self,
			[self, mixed, parent],
			[tie("#all", 9), tie("MID002", 1)],
		);

		expect(above).toEqual({ address: "MID002", by: "use" });
	});

	// A quest group joined before a move can still end in its own quest.
	it("reads its chain from the quest group it works in over one it joined", () => {
		const moved = cell("s", ["7M6JKG"], ["root01", "mid002", "7m6jkg"], {
			groups: ["#quest/old001/7m6jkg", "#quest/root01/mid002/7m6jkg"],
			joined: ["#quest/old001/7m6jkg"],
		});
		const old = cell("o", ["OLD001"], ["old001"]);

		const above = hubFromUse(
			moved,
			[moved, old, parent],
			[tie("OLD001", 9), tie("MID002", 1)],
		);

		expect(above).toEqual({ address: "MID002", by: "use" });
	});

	// A forged presence above, listing a peer this one talks to, would
	// otherwise take that peer's ties and send to it as if it were above.
	it("is never reached at an address another live presence also lists", () => {
		const forged = cell("f", ["HARN01"], ["root01"]);
		const harness = cell("h", ["HARN01"], ["harn01"]);

		const above = hubFromUse(
			self,
			[self, forged, harness, parent],
			[tie("HARN01", 9), tie("MID002", 1)],
		);

		expect(above).toEqual({ address: "MID002", by: "use" });
	});

	// A send to an ended peer's address still reaches it once restored.
	it("is never reached at an address an ended presence also lists", () => {
		const forged = cell("f", ["HARN01"], ["root01"]);
		const ended = cell("h", ["HARN01"], ["harn01"]);

		const above = hubFromUse(
			self,
			[self, forged, parent],
			[tie("HARN01", 9), tie("MID002", 1)],
			[ended],
		);

		expect(above).toEqual({ address: "MID002", by: "use" });
	});

	// A new session on a quest signs with its address as the one before it
	// did, and restored, that one is on the same quest, so above too.
	it("is reached at its quest's address after an earlier session on that quest ended", () => {
		const earlier = cell("p0", ["MID002"], ["root01", "mid002"]);
		const now = cell("p1", ["MID002"], ["root01", "mid002"]);

		const above = hubFromUse(
			self,
			[self, now, root],
			[tie("MID002", 9), tie("ROOT01", 1)],
			[earlier],
		);

		expect(above).toEqual({ address: "MID002", by: "use" });
	});

	// A group joined before the quest was loaded stays joined, and still
	// ends in this cell's own quest.
	it("reads its own quest's chain from a group it had joined before", () => {
		const rejoined = cell("s", ["7M6JKG"], ["root01", "mid002", "7m6jkg"], {
			joined: ["#harness", "#quest/root01/mid002/7m6jkg"],
		});

		const above = hubFromUse(rejoined, [rejoined, parent], [tie("MID002", 1)]);

		expect(above).toEqual({ address: "MID002", by: "use" });
	});

	// Neither quest group is joined, so both count as work and only the
	// own-quest match can choose; the listener's case below bites on the
	// joined filter.
	it("reads the quest chain that ends in its own quest, over another it is in", () => {
		const listening = cell("s", ["7M6JKG"], ["root01", "mid002", "7m6jkg"], {
			groups: ["#quest/other9", "#quest/root01/mid002/7m6jkg"],
			joined: [],
		});
		const elsewhere = cell("o", ["OTHER9"], ["other9"]);

		const above = hubFromUse(
			listening,
			[listening, elsewhere, parent],
			[tie("OTHER9", 9), tie("MID002", 1)],
		);

		expect(above).toEqual({ address: "MID002", by: "use" });
	});

	it("is never a cell that only joined a quest group above to listen", () => {
		const listener = cell("l", ["LISTEN"], [], {
			groups: ["#quest/root01"],
			joined: ["#quest/root01"],
		});

		const above = hubFromUse(
			self,
			[self, listener, parent],
			[tie("LISTEN", 9), tie("MID002", 1)],
		);

		expect(above).toEqual({ address: "MID002", by: "use" });
	});

	it("is never a cell whose older presence lists no joined groups, which reads as all joined", () => {
		const { joined: _, ...older } = root;

		const above = hubFromUse(
			self,
			[self, older, parent],
			[tie("ROOT01", 9), tie("MID002", 1)],
		);

		expect(above).toEqual({ address: "MID002", by: "use" });
	});

	it("adds up a cell's ties across its addresses before choosing", () => {
		const above = hubFromUse(
			self,
			[self, parent, root],
			[tie("ROOT01", 5), tie("MID002", 3), tie("AAAAAA", 3)],
		);

		expect(above).toEqual({ address: "MID002", by: "use" });
	});

	it("gives equal sums to the cell whose single tie is strongest", () => {
		const above = hubFromUse(
			self,
			[self, parent, root],
			[tie("ROOT01", 5), tie("MID002", 3), tie("AAAAAA", 2)],
		);

		expect(above).toEqual({ address: "ROOT01", by: "use" });
	});

	it("is never a cell whose presence gives no peer's address, so a forged one can't widen a send", () => {
		const forged = cell("f", ["#all", "all"], ["root01"]);

		const above = hubFromUse(
			self,
			[self, forged, parent],
			[tie("#all", 9), tie("all", 9), tie("MID002", 1)],
		);

		expect(above).toEqual({ address: "MID002", by: "use" });
	});

	it("is reached by a cell's peer address, never a forged one listed first", () => {
		const mixed = cell("m", ["#all", "ROOT01"], ["root01"]);

		const above = hubFromUse(self, [self, mixed], [tie("ROOT01", 9)]);

		expect(above).toEqual({ address: "ROOT01", by: "use" });
	});

	// Both are shaped as a peer's address, and a send reads each as the
	// machine's group, so either would reach every session.
	it("is never written to by a name a send reads as the machine's group", () => {
		const forged = cell("g", ["global", "Machine"], ["root01"]);
		const mixed = cell("m", ["MID002"], ["root01", "mid002"]);

		const above = hubFromUse(
			self,
			[self, forged, mixed],
			[tie("global", 9), tie("Machine", 9), tie("MID002", 1)],
		);

		expect(above).toEqual({ address: "MID002", by: "use" });
	});

	it("passes over a tie to an address no presence lists", () => {
		const above = hubFromUse(
			self,
			[self, parent],
			[tie("ROOT01", 9), tie("MID002", 1)],
		);

		expect(above).toEqual({ address: "MID002", by: "use" });
	});

	it("is nobody, saying why, for a quest with nothing above it", () => {
		const top = cell("s", ["7M6JKG"], ["7m6jkg"]);

		const above = hubFromUse(top, [top, root], [tie("ROOT01", 9)]);

		expect(above).toEqual({
			none: "no orchestrator is above this peer's quest, QEST-20261021-7M6JKG, and no quest is above it to find a hub from use in",
		});
	});

	it("is nobody, saying why, when no ties came from the node", () => {
		const above = hubFromUse(self, [self, parent], undefined);

		expect(above).toMatchObject({
			none: expect.stringMatching(
				/^no orchestrator is above this peer's quest, QEST-20261021-7M6JKG, and no ties came from the node \(none answered in time, or it keeps none\)/,
			),
		});
	});

	it("is nobody for a peer on no quest", () => {
		const loose = cell("s", ["7M6JKG"], []);

		expect(hubFromUse(loose, [loose, root], [tie("ROOT01", 9)])).toMatchObject({
			none: expect.stringContaining("on no quest"),
		});
	});
});
