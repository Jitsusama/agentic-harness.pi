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
	orchestratorNamed,
} from "../../../lib/mesh/group.ts";

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
});
