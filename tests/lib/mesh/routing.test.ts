import { describe, expect, it } from "vitest";
import { ALL } from "../../../lib/mesh/group.ts";
import type { Presence } from "../../../lib/mesh/presence.ts";
import {
	ALL_AT_LEAST,
	candidatesOf,
	ROUTE_AT_LEAST,
	routeByReferences,
	routeByRule,
	routeFrom,
	routeOf,
	routeQuestion,
	scopesAbove,
} from "../../../lib/mesh/routing.ts";

function presence(
	session: string,
	addresses: string[],
	groups: string[],
	over: Partial<Presence> = {},
): Presence {
	return {
		session,
		addresses,
		groups,
		worksOn: "",
		owns: [],
		busy: false,
		at: "",
		...over,
	};
}

const sender = {
	session: "s-me",
	addresses: ["LUQ49E"],
	scopes: ["#quest/5gv2ah/luq49e", "#repo/agentic-harness-pi"],
};
const me = presence("s-me", ["LUQ49E"], [...sender.scopes, "#harness"]);
const stick = presence(
	"s-stick",
	["2HN63P"],
	["#stick", "#repo/core-nix", "#repo/world"],
);
const power = presence("s-power", ["P9R1KI"], ["#optimus/power"]);
const optimus = presence("s-optimus", ["WCJQSG"], ["#optimus"]);
const everyone = [me, stick, power, optimus];

describe("candidatesOf", () => {
	it("lists the named groups others are in, narrowest first", () => {
		const harness = presence("s-harness", ["5GV2AH"], ["#harness", ALL]);
		expect(
			candidatesOf([...everyone, harness], sender).map(({ group }) => group),
		).toEqual([
			"#harness",
			"#optimus",
			"#optimus/power",
			"#repo/core-nix",
			"#repo/world",
			"#stick",
		]);
	});
});

describe("routeByReferences", () => {
	it("goes to the groups the text names, written as people write them", () => {
		expect(
			routeByReferences("core.nix fails its flake check", sender, everyone)?.to,
		).toEqual(["#repo/core-nix"]);
		expect(
			routeByReferences("The stick's VM test hangs", sender, everyone)?.to,
		).toEqual(["#stick"]);
	});

	it("leaves out a group a broader one it names already reaches", () => {
		expect(
			routeByReferences("optimus power throttles jobs", sender, everyone)?.to,
		).toEqual(["#optimus"]);
	});

	it("goes to the home of a peer it names that no named group reaches", () => {
		const owner = presence("s-owner", ["OVAE1I"], [], {
			owns: ["skynet-kit"],
		});
		expect(
			routeByReferences("P9R1KI, the skynet-kit build is yours", sender, [
				...everyone,
				owner,
			]),
		).toEqual({
			to: ["@P9R1KI", "@OVAE1I"],
			why: "it names P9R1KI, OVAE1I or what they own",
		});
	});

	it("is nothing when the text names nothing, or only a short word", () => {
		const short = presence("s-short", ["ABCDEF"], ["#vm"]);
		expect(
			routeByReferences("the vm is slow", sender, [...everyone, short]),
		).toBeUndefined();
		expect(routeByReferences("going to lunch", sender, everyone)).toBe(
			undefined,
		);
	});

	it("never routes to the sender itself", () => {
		expect(
			routeByReferences("LUQ49E on #harness", sender, everyone),
		).toBeUndefined();
	});
});

describe("routeFrom", () => {
	const { keys } = routeQuestion(
		{ intent: "fyi", text: "x" },
		sender,
		candidatesOf(everyone, sender),
	);
	const picked = (choice: string, sure: number) => ({
		type: "choice",
		choice,
		probabilities: { [choice]: sure },
	});

	it("takes the classifier's group only when it is sure", () => {
		expect(routeFrom(picked("g1", ROUTE_AT_LEAST), keys)?.to).toEqual([
			"#optimus",
		]);
		expect(routeFrom(picked("all", ALL_AT_LEAST), keys)?.to).toEqual([ALL]);
		expect(routeFrom(picked("g1", ROUTE_AT_LEAST - 0.01), keys)).toBe(
			undefined,
		);
	});

	it("holds the whole machine to a higher bar", () => {
		expect(routeFrom(picked("all", ALL_AT_LEAST - 0.01), keys)).toBe(undefined);
	});

	it("is nothing for an answer it cannot read", () => {
		expect(routeFrom(picked("g99", 0.99), keys)).toBeUndefined();
		expect(routeFrom(undefined, keys)).toBeUndefined();
		expect(routeFrom({ type: "bool", probability: 1 }, keys)).toBe(undefined);
	});
});

describe("routeByRule", () => {
	it("holds the whole machine with a hold", () => {
		expect(routeByRule("hold", sender, everyone).to).toEqual([ALL]);
	});

	it("goes to the sender's scopes another peer is in", () => {
		const colleague = presence("s-c", ["5GV2AH"], ["#repo/agentic-harness-pi"]);
		expect(routeByRule("fyi", sender, [...everyone, colleague]).to).toEqual([
			"#repo/agentic-harness-pi",
		]);
	});

	it("goes to the whole machine when no other peer is on the sender's work", () => {
		expect(routeByRule("question", sender, everyone).to).toEqual([ALL]);
	});

	it("goes to the nearest quest above the sender's own that another peer hears", () => {
		const parent = presence("s-p", ["5GV2AH"], ["#quest/5gv2ah"]);
		const deeper = { ...sender, scopes: ["#quest/5gv2ah/luq49e/x"] };

		expect(routeByRule("fyi", deeper, [...everyone, parent]).to).toEqual([
			"#quest/5gv2ah",
		]);
		const nearer = presence("s-n", ["Q2Q2Q2"], ["#quest/5gv2ah/luq49e"]);
		expect(
			routeByRule("fyi", deeper, [...everyone, parent, nearer]).to,
		).toEqual(["#quest/5gv2ah/luq49e"]);
		expect(routeByRule("hold", deeper, [...everyone, parent]).to).toEqual([
			ALL,
		]);
	});
});

describe("scopesAbove", () => {
	it("is each quest above a quest's scope, nearest first, and none for a repository", () => {
		expect(scopesAbove("#quest/a/b/c")).toEqual(["#quest/a/b", "#quest/a"]);
		expect(scopesAbove("#quest/a")).toEqual([]);
		expect(scopesAbove("#repo/agentic-harness-pi")).toEqual([]);
	});
});

describe("routeOf", () => {
	const sure = async () => ({
		type: "choice",
		choice: "g1",
		probabilities: { g1: 0.95 },
	});

	it("goes by references before asking the classifier", async () => {
		const asked: unknown[] = [];
		const route = await routeOf(
			{ intent: "finding", text: "the stick hangs" },
			sender,
			everyone,
			async (context) => {
				asked.push(context);
				return sure();
			},
		);
		expect(route.to).toEqual(["#stick"]);
		expect(asked).toEqual([]);
	});

	it("asks the classifier when the words point nowhere", async () => {
		expect(
			(await routeOf({ intent: "fyi", text: "x" }, sender, everyone, sure)).to,
		).toEqual(["#optimus"]);
	});

	it("goes by rule when the classifier fails", async () => {
		const failing = async () => {
			throw new Error("down");
		};
		expect(
			(await routeOf({ intent: "fyi", text: "x" }, sender, everyone, failing))
				.to,
		).toEqual([ALL]);
	});

	it("never goes to a peer that stopped the sender", async () => {
		const stopping = presence("s-stick", ["2HN63P"], ["#stick"], {
			stops: [{ address: "LUQ49E", at: "" }],
		});
		expect(
			(
				await routeOf({ intent: "finding", text: "the stick hangs" }, sender, [
					me,
					stopping,
				])
			).to,
		).toEqual([ALL]);
	});
});
