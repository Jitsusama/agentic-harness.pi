/**
 * Groups: how they are written, and who hears them.
 */
import { describe, expect, it } from "vitest";
import {
	ALL,
	groupNamed,
	groupsNamed,
	hears,
	isJoinable,
	MOST_GROUP_CHARS,
	needNamed,
	orchestratorNamed,
	personLeftOut,
	personNamed,
} from "../../../lib/mesh/group.ts";

describe("the person in `to`", () => {
	it("is read as the address of the person's steward", () => {
		expect(personNamed("person, #harness", "WCJQSG")).toBe("WCJQSG, #harness");
		expect(personNamed("Person", "WCJQSG")).toBe("WCJQSG");
	});

	it("reads as the orchestrator where no steward is set", () => {
		expect(personNamed("person, 85PKB2", undefined)).toBe(
			"orchestrator, 85PKB2",
		);
	});

	// As with `need`: a group called #person, and a quest whose address
	// is PERSON, are still reached as themselves.
	it("is only the bare word, leaving a group or address of that name", () => {
		expect(personNamed("#person, @PERSON", "WCJQSG")).toBe("#person, @PERSON");
	});

	it("is left out for the steward itself, which says it in its reply", () => {
		expect(
			[personLeftOut("person, #harness"), personLeftOut("Person")],
			"the rest, then nothing",
		).toEqual(["#harness", undefined]);
	});

	// An empty `to` routes by rule or back to the asker, and one spaced
	// its own way must not read as having lost the word.
	it("leaves a `to` that never names it as written", () => {
		expect([personLeftOut(""), personLeftOut("#harness,#ops ")]).toEqual([
			"",
			"#harness,#ops ",
		]);
	});

	it("names the steward once, though it was also named by address", () => {
		expect(personNamed("WCJQSG, person", "WCJQSG")).toBe("WCJQSG");
	});

	it("leaves a `to` that does not name it as written", () => {
		expect(personNamed("#harness,85PKB2", "WCJQSG")).toBe("#harness,85PKB2");
	});
});

describe("a need in `to`", () => {
	it("is taken out, and said, as the bare word in any case", () => {
		expect(needNamed("need, #harness")).toEqual({
			to: "#harness",
			asked: true,
		});
		expect(needNamed(" Need ")).toEqual({ to: "", asked: true });
	});

	it("leaves a group called #need reachable, and a `to` that does not name it as written", () => {
		expect(needNamed("#need")).toEqual({ to: "#need", asked: false });
		expect(needNamed("#needs, 85PKB2")).toEqual({
			to: "#needs, 85PKB2",
			asked: false,
		});
	});
});

describe("the orchestrator in `to`", () => {
	it("is read as the address of the orchestrator above the sender's quest", () => {
		expect(orchestratorNamed("orchestrator, #harness", "WCJQSG")).toEqual({
			to: "WCJQSG, #harness",
			missing: false,
		});
		expect(orchestratorNamed("@Orchestrator", "WCJQSG").to).toBe("WCJQSG");
	});

	it("is dropped, and said, for a sender with no orchestrator above it", () => {
		expect(orchestratorNamed("orchestrator, 85PKB2", undefined)).toEqual({
			to: "85PKB2",
			missing: true,
		});
	});

	it("leaves a `to` that does not name it as written", () => {
		expect(orchestratorNamed("#harness", undefined)).toEqual({
			to: "#harness",
			missing: false,
		});
	});
});

describe("a group's name", () => {
	it("is made canonical however it is typed", () => {
		expect(groupNamed("#Harness")).toBe("#harness");
		expect(groupNamed(" #optimus/power ")).toBe("#optimus/power");
		expect(groupNamed("p9r1ki")).toBe("@P9R1KI");
		expect(groupNamed("@P9R1KI")).toBe("@P9R1KI");
	});

	it("is the machine's for #machine, all, #all and #global", () => {
		expect(groupNamed("#machine")).toBe(ALL);
		expect(groupNamed("machine")).toBe(ALL);
		expect(groupNamed("all")).toBe(ALL);
		expect(groupNamed("#all")).toBe(ALL);
		expect(groupNamed("#global")).toBe(ALL);
	});

	it("is nothing for what cannot be one", () => {
		expect(groupNamed("#two words")).toBeUndefined();
		expect(groupNamed("#optimus//power")).toBeUndefined();
		expect(groupNamed("#")).toBeUndefined();
		expect(groupNamed("two words")).toBeUndefined();
	});

	it("is read from a list as typed, keeping what is not one as written", () => {
		expect(groupsNamed("#Harness, #global, all, p9r1ki,, #a b")).toEqual([
			"#harness",
			ALL,
			"@P9R1KI",
			"#a b",
		]);
	});
});

describe("who hears a group", () => {
	it("is whoever is in it or in one of its parts", () => {
		expect(
			hears(["#optimus/power"], "#optimus"),
			"a member of #optimus/power hears #optimus",
		).toBe(true);
		expect(
			hears(["#optimus/power"], "#optimus/power"),
			"a member of #optimus/power hears it",
		).toBe(true);
		expect(
			hears(["#optimus"], "#optimus/power"),
			"a member of #optimus does not hear #optimus/power",
		).toBe(false);
		// A prefix that is not a parent is not one.
		expect(
			hears(["#optimusprime"], "#optimus"),
			"a member of #optimusprime does not hear #optimus",
		).toBe(false);
	});

	it("is everyone, for the machine's", () => {
		expect(hears([], ALL), "a peer in no group hears the machine's").toBe(true);
	});
});

describe("joining", () => {
	it("is for named groups and other peers' home groups, not the machine's", () => {
		expect(isJoinable("#harness"), "#harness is joinable").toBe(true);
		expect(isJoinable("@P9R1KI"), "@P9R1KI is joinable").toBe(true);
		expect(isJoinable(ALL), "the machine's group is not joinable").toBe(false);
	});

	it("is for no group longer than a presence may name", () => {
		const longest = `#${"a".repeat(MOST_GROUP_CHARS - 1)}`;

		expect(
			isJoinable(longest),
			"the longest name a presence may hold is joinable",
		).toBe(true);
		expect(
			isJoinable(`${longest}a`),
			"a name past the longest is not joinable",
		).toBe(false);
	});
});
