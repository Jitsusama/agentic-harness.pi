/**
 * Skills listed only where the person says they apply.
 */
import { describe, expect, it } from "vitest";
import {
	parseLoadoutSettings,
	skillsHere,
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
		expect(names(skillsHere(skills, {}, "/anywhere", HOME))).toEqual(
			names(skills),
		);
	});

	it("leave out a skill named for another place, by prefix", () => {
		const places = { "shopify-world-*": ["~/world"] };

		expect(
			names(skillsHere(skills, places, `${HOME}/src/agentic-harness.pi`, HOME)),
		).toEqual(["planning-guide", "shopify-vault-guide"]);
		expect(
			names(skillsHere(skills, places, `${HOME}/world/trees/root/src`, HOME)),
		).toEqual(names(skills));
	});

	it("go by the most specific key", () => {
		const places = {
			"shopify-*": ["~/world"],
			"shopify-vault-guide": ["~"],
		};

		expect(names(skillsHere(skills, places, `${HOME}/src/x`, HOME))).toEqual([
			"planning-guide",
			"shopify-vault-guide",
		]);
	});

	it("do not count a folder that only starts with the same letters", () => {
		const places = { "shopify-world-*": ["~/world"] };

		expect(
			names(skillsHere(skills, places, `${HOME}/worldly`, HOME)),
		).not.toContain("shopify-world-pr-convention");
	});
});

describe("the loadout section", () => {
	it("is nothing to filter when absent", () => {
		expect(parseLoadoutSettings(undefined)).toEqual({
			ok: true,
			value: { skills: {} },
		});
	});

	it("takes a list of folders per key, and refuses anything else", () => {
		expect(
			parseLoadoutSettings({ skills: { "shopify-world-*": ["~/world"] } }),
		).toEqual({
			ok: true,
			value: { skills: { "shopify-world-*": ["~/world"] } },
		});
		expect(parseLoadoutSettings({ skills: { x: "~/world" } }).ok).toBe(false);
		expect(parseLoadoutSettings([]).ok).toBe(false);
	});
});
