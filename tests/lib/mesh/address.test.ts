/**
 * A peer's addresses: what it signs with and answers to.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addressesOf,
	answeringTo,
	isAddress,
	namedAtStart,
	olderAddresses,
	questAddress,
	signedSince,
	signingSince,
	yieldsTo,
} from "../../../lib/mesh/address.ts";

describe("what can be a peer's address", () => {
	it("takes a quest's six and a session's eight, in any letters", () => {
		expect(isAddress("5HJZ8Z"), "a quest's").toBe(true);
		expect(isAddress("2c5c7edb"), "a session's, lower-cased").toBe(true);
	});

	it("refuses the person's and the machine's names, which have the shape", () => {
		expect(isAddress("person"), "the person").toBe(false);
		expect(isAddress("PERSON"), "in capitals").toBe(false);
		expect(isAddress("Machine"), "the machine").toBe(false);
	});

	it("refuses what has no address's shape", () => {
		expect(isAddress("need"), "too short").toBe(false);
		expect(isAddress("send-it-to-ZZ9ZZZ"), "a phrase").toBe(false);
	});
});

let root: string;
const session = "01a15f3a-2255-7463-9909-afa624b025fe";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-address-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const records = () => ({
	sessions: join(root, "sessions"),
	quests: join(root, "quests"),
});

function quest(id: string, lists: string) {
	mkdirSync(join(root, "quests", id), { recursive: true });
	writeFileSync(join(root, "quests", id, "README.md"), lists, "utf8");
}

function loaded(questId: string) {
	mkdirSync(join(root, "sessions"), { recursive: true });
	writeFileSync(
		join(root, "sessions", `${session}.json`),
		JSON.stringify({ quest: questId }),
		"utf8",
	);
}

describe("a quest's address, when two sessions have it loaded", () => {
	const holder = { session: "02-holder", addresses: ["7M6JKG", "02HOLDER"] };
	const older = { session: "00-older", addresses: ["7M6JKG"] };
	const elsewhere = { session: "00-else", addresses: ["P9R1KI"] };

	it("is left by a peer starting to one already signing with it", () => {
		expect(yieldsTo("01-me", "7M6JKG", false, [holder, elsewhere])).toBe(
			holder,
		);
		expect(yieldsTo("01-me", "7M6JKG", false, [elsewhere])).toBeUndefined();
		expect(yieldsTo("01-me", undefined, false, [holder])).toBeUndefined();
	});

	it("is kept by the lower session id when both sign with it", () => {
		expect(yieldsTo("01-me", "7M6JKG", true, [holder])).toBeUndefined();
		expect(yieldsTo("01-me", "7M6JKG", true, [older, holder])).toBe(older);
		expect(yieldsTo("02-holder", "7M6JKG", true, [holder])).toBeUndefined();
	});

	it("is kept by the one that has signed with it longer, whatever its id", () => {
		// On 25 November a session that resumed as optimus restarted saw
		// nobody sign with its quest's address, since the holder on another
		// machine wasn't heard yet, took it, and then kept it over that
		// holder for having the lower id: its orchestrator's asks went to it.
		const held = { ...holder, signsSince: "2026-11-21T20:47:00.000Z" };
		const taken = { ...older, signsSince: "2026-11-25T13:53:49.000Z" };

		expect(
			yieldsTo("00-older", "7M6JKG", true, [held], taken.signsSince),
			"the one that took it gives it back",
		).toBe(held);
		expect(
			yieldsTo("02-holder", "7M6JKG", true, [taken], held.signsSince),
			"the one that held it keeps it",
		).toBeUndefined();
	});

	it("is kept by the lower id when either says no time, as an older harness doesn't", () => {
		const held = { ...holder, signsSince: "2026-11-21T20:47:00.000Z" };

		expect(yieldsTo("00-older", "7M6JKG", true, [held])).toBeUndefined();
		expect(
			yieldsTo("02-holder", "7M6JKG", true, [older], held.signsSince),
		).toBe(older);
	});

	it("is kept by the lower id when both took it at the same time", () => {
		const atOnce = "2026-11-25T13:53:49.000Z";

		expect(
			yieldsTo(
				"00-older",
				"7M6JKG",
				true,
				[{ ...holder, signsSince: atOnce }],
				atOnce,
			),
		).toBeUndefined();
		expect(
			yieldsTo(
				"02-holder",
				"7M6JKG",
				true,
				[{ ...older, signsSince: atOnce }],
				atOnce,
			),
		).toEqual({ ...older, signsSince: atOnce });
	});

	it("is contested by a restarted holder only where the signer says a time too", () => {
		// Restarted, it signs with nothing yet but kept the time it held from.
		const before = "2026-11-21T20:47:00.000Z";
		const taken = { ...holder, signsSince: "2026-11-25T13:53:49.000Z" };

		expect(
			yieldsTo("03-me", "7M6JKG", false, [taken], before),
			"it keeps it from one that took it since",
		).toBeUndefined();
		expect(
			yieldsTo("00-me", "7M6JKG", false, [holder], before),
			"and leaves it to an older harness's holder, as it always did",
		).toBe(holder);
	});

	it("is kept by exactly one of three signers when one says no time", () => {
		// Times for some and ids for others ranked a against b, b against c
		// and c against a in a ring, so each could leave it to another.
		const a = {
			session: "03-a",
			addresses: ["7M6JKG"],
			signsSince: "2026-11-21T20:47:00.000Z",
		};
		const b = {
			session: "01-b",
			addresses: ["7M6JKG"],
			signsSince: "2026-11-25T13:53:49.000Z",
		};
		const c = { session: "02-c", addresses: ["7M6JKG"] };
		const all: { session: string; addresses: string[]; signsSince?: string }[] =
			[a, b, c];

		const keepers = all.filter(
			(one) =>
				yieldsTo(one.session, "7M6JKG", true, all, one.signsSince) ===
				undefined,
		);

		expect(keepers).toEqual([b]);
	});
});

describe("what a restart keeps of holding its quest's address", () => {
	const now = Date.parse("2026-11-25T16:00:00.000Z");
	const last = {
		addresses: ["7M6JKG", "24B025FE"],
		signsSince: "2026-11-21T20:47:00.000Z",
		at: "2026-11-25T15:59:30.000Z",
	};
	const kept = { address: "7M6JKG", since: "2026-11-21T20:47:00.000Z" };

	it("keeps the time across a kill that said nothing moments before", () => {
		expect(signedSince(last, now)).toEqual(kept);
	});

	it("starts afresh after a kill that last said anything an hour ago", () => {
		expect(
			signedSince({ ...last, at: "2026-11-25T15:00:00.000Z" }, now),
		).toBeUndefined();
	});

	it("keeps the time across a park however long it slept, while its marker stands", () => {
		const slept = {
			...last,
			session: "s",
			at: "2026-11-24T16:00:00.000Z",
			state: "parked",
		};

		expect(signedSince(slept, now, { parked: () => true })).toEqual(kept);
		expect(
			signedSince(slept, now, { parked: () => false }),
			"nor once a reboot voided its marker",
		).toBeUndefined();
	});

	it("bounds a park that ended by when it ended, not by its marker", () => {
		expect(
			signedSince(
				{
					...last,
					session: "s",
					state: "parked",
					ended: "2026-11-25T15:00:00.000Z",
				},
				now,
				{ parked: () => true },
			),
		).toBeUndefined();
	});

	it("keeps the time across a reload, which the same process starts however long it was quiet", () => {
		const owner = { pid: 4242, startedAt: 1_000, bootId: "b" };
		const quiet = { ...last, at: "2026-11-25T12:00:00.000Z", owner };

		expect(signedSince(quiet, now, { owner })).toEqual(kept);
		expect(
			signedSince(quiet, now, { owner: { ...owner, startedAt: 9_000_000 } }),
			"nor for a new process wearing its pid",
		).toBeUndefined();
		expect(
			signedSince(quiet, now, { owner: { ...owner, bootId: "c" } }),
			"nor for one in another boot",
		).toBeUndefined();
	});

	it("keeps it up to ten minutes after its last word, and not a moment past", () => {
		expect(
			signedSince({ ...last, at: "2026-11-25T15:50:00.000Z" }, now),
		).toEqual(kept);
		expect(
			signedSince({ ...last, at: "2026-11-25T15:49:59.999Z" }, now),
		).toBeUndefined();
	});

	it("starts afresh after a last word dated far ahead, as a clock set wrong writes", () => {
		expect(
			signedSince({ ...last, at: "2026-11-26T16:00:00.000Z" }, now),
		).toBeUndefined();
	});

	it("keeps it across one that ended moments before, as a rollover does", () => {
		expect(
			signedSince({ ...last, ended: "2026-11-25T15:59:30.000Z" }, now),
		).toEqual(kept);
	});

	it("starts afresh after a quit reopened later", () => {
		expect(
			signedSince({ ...last, ended: "2026-11-25T15:00:00.000Z" }, now),
		).toBeUndefined();
	});

	it("keeps the time while it signs, starts it on taking, and drops it on yielding", () => {
		const held = "2026-11-21T20:47:00.000Z";

		expect(signingSince("7M6JKG", ["7M6JKG", "24B025FE"], held, now)).toEqual(
			kept,
		);
		expect(signingSince("7M6JKG", ["7M6JKG"], undefined, now)).toEqual({
			address: "7M6JKG",
			since: "2026-11-25T16:00:00.000Z",
		});
		expect(signingSince("7M6JKG", ["24B025FE"], held, now)).toBeUndefined();
		expect(signingSince(undefined, ["24B025FE"], held, now)).toBeUndefined();
	});

	it("keeps nothing where the last presence said no time", () => {
		expect(
			signedSince({ addresses: ["7M6JKG"], at: last.at }, now),
		).toBeUndefined();
		expect(signedSince(undefined, now)).toBeUndefined();
	});
});

describe("a peer's addresses", () => {
	it("are a quest's last six letters", () => {
		expect(questAddress("QEST-20261021-luq49e")).toBe("LUQ49E");
	});

	it("sign with the quest it has loaded, ahead of older quests", () => {
		// A session listed in two READMEs once signed with whichever the
		// folder happened to list last.
		quest("QEST-20261021-AF7P9P", `- ${session}`);
		quest("QEST-20261021-7M6JKG", `- ${session}`);
		loaded("QEST-20261021-7M6JKG");

		expect(addressesOf(session, records())).toEqual([
			"7M6JKG",
			"AF7P9P",
			"24B025FE",
		]);
	});

	it("include an older quest that lists it, so what was sent there arrives", () => {
		quest("QEST-20261021-AF7P9P", `- ${session}`);
		quest("QEST-20261021-ZZZZZZ", "- someone-else");

		expect(addressesOf(session, records())).toEqual(["AF7P9P", "24B025FE"]);
	});

	it("give up an older quest that another peer now signs with", () => {
		// Seen live: the session that spawned LUQ49E still answered to it,
		// and took every message LUQ49E sent for one of its own.
		quest("QEST-20261021-LUQ49E", `- ${session}`);
		loaded("QEST-20261021-5GV2AH");

		expect(
			addressesOf(
				session,
				records(),
				olderAddresses(session, records()),
				new Set(["LUQ49E"]),
			),
		).toEqual(["5GV2AH", "24B025FE"]);
	});

	it("as another peer sees them, never include what a third signs with", () => {
		const spawner = { session: "s-1", addresses: ["5GV2AH", "LUQ49E"] };
		const spawned = { session: "s-2", addresses: ["LUQ49E"] };

		expect(answeringTo(spawner, [spawner, spawned])).toEqual(["5GV2AH"]);
		expect(answeringTo(spawned, [spawner, spawned])).toEqual(["LUQ49E"]);
	});

	it("leave the quest's address out when it was left to another peer", () => {
		loaded("QEST-20261021-7M6JKG");

		expect(addressesOf(session, records(), [], new Set(), true)).toEqual([
			"24B025FE",
		]);
	});

	it("hold its own address once, though its last presence already ends with it", () => {
		quest("QEST-20261021-AF7P9P", `- ${session}`);

		expect(addressesOf(session, records(), ["AF7P9P", "24B025FE"])).toEqual([
			"AF7P9P",
			"24B025FE",
		]);
	});

	it("are the session id's tail alone with no quest store", () => {
		expect(addressesOf(session, records())).toEqual(["24B025FE"]);
	});
});

describe("the peers a message opens by naming", () => {
	const everyone = [
		{ session: "me", addresses: ["LUQ49E"] },
		{ session: "p", addresses: ["P9R1KI", "CA6H2X"] },
		{ session: "w", addresses: ["WCJQSG"] },
	];

	it("are the peers before its colon, by what each signs with", () => {
		expect(namedAtStart("P9R1KI: may I write it?", "me", everyone)).toEqual([
			"P9R1KI",
		]);
		expect(
			namedAtStart("ca6h2x and @WCJQSG: the schema", "me", everyone),
		).toEqual(["P9R1KI", "WCJQSG"]);
		expect(namedAtStart("@WCJQSG the schema is in", "me", everyone)).toEqual([
			"WCJQSG",
		]);
	});

	it("are none when the opening names anything else, its sender included", () => {
		expect(namedAtStart("LUQ49E: the shape suits", "me", everyone)).toEqual([]);
		expect(namedAtStart("Joel, P9R1KI: hold", "me", everyone)).toEqual([]);
		expect(namedAtStart("Note: P9R1KI builds", "me", everyone)).toEqual([]);
		expect(namedAtStart("the queue, P9R1KI: yes", "me", everyone)).toEqual([]);
	});
});
