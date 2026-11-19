/**
 * A need found by a subject naming a service unit whole, as owner
 * prefixes such as `unstamped:agents.service` do: the unit's name is the
 * subject, and its `.service` is only the unit's type.
 */

import { describe, expect, it } from "vitest";
import { foragersFrom, subjectWords } from "../../../lib/mesh/need-route.ts";
import { asked, cells, numbered, routeNeed, ties } from "./support/needs.ts";

/** The node's list of one cell declaring two service units, as it says it. */
const NODE_CELL = JSON.stringify({
	id: 2,
	records: [
		{
			key: "cell:KP0L6A",
			title: "Node",
			subjects: ["unstamped:agents.service", "unstamped:windows.service"],
		},
	],
});

describe("the words a subject naming a service unit gives", () => {
	it("reads a unit's name as its narrowest part, never its type", () => {
		// Owner prefixes name units whole, and a unit's type is no subject:
		// every service would otherwise claim one word and lose its own.
		expect(subjectWords("unstamped:agents.service")).toEqual(["agents"]);
		expect(subjectWords("failed:pulse-sampler.service")).toEqual([
			"pulse",
			"sampler",
		]);
		expect(subjectWords("failed:com.shopify.monobus.service")).toEqual([
			"monobus",
		]);
		expect(subjectWords("failed:systemd-coredump@.service")).toEqual([
			"systemd",
			"coredump",
		]);
		// The node lowercases a hub's subject; a cell's comes as declared.
		expect(subjectWords("unstamped:Agents.Service")).toEqual(["agents"]);
	});

	it("reads service as a subject wherever it isn't a unit's type", () => {
		// Only a name's own .service is a type: alone after a break it is
		// the subject, as is any other ending, and a namespace's last part.
		expect(subjectWords("unit:.service")).toEqual(["service"]);
		expect(subjectWords("github:mycelium/.service")).toEqual(["service"]);
		expect(subjectWords("health.service.")).toEqual(["service"]);
		expect(subjectWords("agents.service-mesh")).toEqual(["service", "mesh"]);
		expect(subjectWords("agents.servicex")).toEqual(["servicex"]);
		expect(subjectWords("oauth.scope")).toEqual(["scope"]);
		expect(subjectWords("build.target")).toEqual(["target"]);
	});

	it("gives a cell its units' names from the subjects the node lists", () => {
		expect(foragersFrom(NODE_CELL)).toEqual([
			{ address: "KP0L6A", words: ["node", "agents", "windows"] },
		]);
	});
});

describe("a need routed by a subject naming a service unit", () => {
	it("reaches the cell declaring the unit through the unit's hub", () => {
		const found = routeNeed(asked("A", "agents"), {
			foragers: [...cells({ A: [] }), ...foragersFrom(NODE_CELL)],
			ties: ties(),
			hubs: [
				{
					subject: "unstamped:agents.service",
					hub: "KP0L6A",
					fits: ["KP0L6A"],
				},
			],
		});

		expect(found, "the unit's name is its hub's subject").toMatchObject({
			fit: "KP0L6A",
		});
	});

	it("counts no part for a unit's type when ranking hubs by depth", () => {
		// Were the type a part, both hubs would be three deep and the needs
		// shared between them; as no part, every one goes to the deeper.
		const fits = numbered("A", "agents").map(
			(need) =>
				routeNeed(need, {
					foragers: cells({ A: [], U: ["agents"], D: ["agents"] }),
					ties: ties(),
					hubs: [
						{ subject: "unstamped:agents.service", hub: "U", fits: ["U"] },
						{ subject: "a:b:agents", hub: "D", fits: ["D"] },
					],
				}).fit,
		);

		expect(new Set(fits), "three parts beat the unit's two").toEqual(
			new Set(["D"]),
		);
	});
});
