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
	namedAtStart,
	olderAddresses,
	questAddress,
	yieldsTo,
} from "../../../lib/mesh/address.ts";

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
