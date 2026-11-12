/**
 * Skills listed only where the person says they apply.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	parseLoadoutSettings,
	placedHere,
	withPackagePlaces,
} from "../../../extensions/loadout-workflow/skills.ts";

const HOME = "/home/someone";
const skills = [
	{ name: "planning-guide" },
	{ name: "shopify-world-pr-convention" },
	{ name: "shopify-world-git-convention" },
	{ name: "shopify-vault-guide" },
];
const names = (listed: readonly { name: string }[]) =>
	listed.map((one) => one.name);

describe("the skills listed for a session", () => {
	it("are every skill when no place is said", () => {
		expect(names(placedHere(skills, {}, "/anywhere", HOME))).toEqual(
			names(skills),
		);
	});

	it("leave out a skill named for another place, by prefix", () => {
		const places = { "shopify-world-*": ["~/world"] };

		expect(
			names(placedHere(skills, places, `${HOME}/src/agentic-harness.pi`, HOME)),
		).toEqual(["planning-guide", "shopify-vault-guide"]);
		expect(
			names(placedHere(skills, places, `${HOME}/world/trees/root/src`, HOME)),
		).toEqual(names(skills));
	});

	it("go by the most specific key", () => {
		const places = {
			"shopify-*": ["~/world"],
			"shopify-vault-guide": ["~"],
		};

		expect(names(placedHere(skills, places, `${HOME}/src/x`, HOME))).toEqual([
			"planning-guide",
			"shopify-vault-guide",
		]);
	});

	it("do not count a folder that only starts with the same letters", () => {
		const places = { "shopify-world-*": ["~/world"] };

		expect(
			names(placedHere(skills, places, `${HOME}/worldly`, HOME)),
		).not.toContain("shopify-world-pr-convention");
	});
});

// A review round's output contract is attached to the round's own
// isolated pi, which lists it there; listed in every other session, the
// five cost about 2,300 characters a turn for nothing.
describe("the package's own places", () => {
	const withContract = [...skills, { name: "review-council-format" }];

	it("list a review round's contract in no ordinary session", () => {
		expect(
			names(placedHere(withContract, withPackagePlaces({}), "/anywhere", HOME)),
		).toEqual(names(skills));
	});

	it("name every review round's contract the package ships", () => {
		const contracts = readdirSync(join(import.meta.dirname, "../../../skills"))
			.filter((name) => /^review-.+-format$/.test(name))
			.map((name) => ({ name }));

		expect(
			contracts.length,
			"the package ships its round contracts",
		).toBeGreaterThan(4);
		expect(
			names(placedHere(contracts, withPackagePlaces({}), "/anywhere", HOME)),
		).toEqual([]);
	});

	it("give way to a place the person says", () => {
		const places = withPackagePlaces({ "review-council-format": ["~"] });

		expect(
			names(placedHere(withContract, places, `${HOME}/src`, HOME)),
		).toEqual(names(withContract));
	});
});

describe("the loadout section", () => {
	it("is nothing to filter when absent", () => {
		expect(parseLoadoutSettings(undefined)).toEqual({
			ok: true,
			value: { skills: {}, tools: {} },
		});
	});

	it("takes a list of folders per key, and refuses anything else", () => {
		expect(
			parseLoadoutSettings({ skills: { "shopify-world-*": ["~/world"] } }),
		).toEqual({
			ok: true,
			value: { skills: { "shopify-world-*": ["~/world"] }, tools: {} },
		});
		expect(parseLoadoutSettings({ skills: { x: "~/world" } })).toMatchObject({
			ok: false,
		});
		expect(parseLoadoutSettings([])).toMatchObject({ ok: false });
	});

	it("takes tools' places the same way as skills'", () => {
		expect(
			parseLoadoutSettings({
				tools: { "mastery_*": ["~/src/joel.gerber.pi"] },
			}),
		).toEqual({
			ok: true,
			value: { skills: {}, tools: { "mastery_*": ["~/src/joel.gerber.pi"] } },
		});
		expect(parseLoadoutSettings({ tools: { "mastery_*": "~/src" } })).toEqual({
			ok: false,
			error: 'loadout.tools["mastery_*"] must be a list of folders',
		});
		expect(parseLoadoutSettings({ tools: [] })).toEqual({
			ok: false,
			error: "loadout.tools must be an object",
		});
	});
});

describe("the tools indexed for a session", () => {
	const tools = [
		{ name: "bash" },
		{ name: "mastery_start_cycle" },
		{ name: "mastery_collect_git" },
	];
	const places = { "mastery_*": ["~/src/joel.gerber.pi"] };

	it("leave out a tool named for another place", () => {
		expect(names(placedHere(tools, places, `${HOME}/src/x`, HOME))).toEqual([
			"bash",
		]);
	});

	it("keep it where it applies", () => {
		expect(
			names(placedHere(tools, places, `${HOME}/src/joel.gerber.pi/lib`, HOME)),
		).toEqual(names(tools));
	});
});
