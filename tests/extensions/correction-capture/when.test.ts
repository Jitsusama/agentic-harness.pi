/**
 * Captured rules said only where they apply.
 */
import { describe, expect, it } from "vitest";
import {
	residentRules,
	rulesForSkill,
	skillRead,
	whenOf,
} from "../../../extensions/correction-capture/when.ts";

const always = { id: "a", text: "Always." };
const design = { id: "d", text: "Design.", when: { skill: "aesthetic" } };
const nix = { id: "n", text: "Nix.", when: { file: "flake.nix" } };
const rules = [always, design, nix];
const ids = (listed: readonly { id: string }[]) => listed.map((r) => r.id);

describe("the rules resident in a session", () => {
	it("keep a rule that says nothing of when, and leave out a skill's", () => {
		expect(ids(residentRules(rules, "/src/app", () => false))).toEqual(["a"]);
	});

	it("keep a file's rule where the file is in the folder or above", () => {
		const exists = (path: string) => path === "/src/flake.nix";

		expect(ids(residentRules(rules, "/src/app/lib", exists))).toEqual([
			"a",
			"n",
		]);
		expect(ids(residentRules(rules, "/other", exists))).toEqual(["a"]);
	});
});

describe("the rules said with a skill", () => {
	it("are the ones that name it", () => {
		expect(ids(rulesForSkill(rules, "aesthetic"))).toEqual(["d"]);
		expect(rulesForSkill(rules, "browser-guide")).toEqual([]);
	});

	it("follow a read of that skill's instructions, and nothing else", () => {
		expect(skillRead("/home/x/.pi/agent/skills/aesthetic/SKILL.md")).toBe(
			"aesthetic",
		);
		expect(skillRead("/home/x/notes/aesthetic.md")).toBeUndefined();
	});
});

describe("when a rule applies", () => {
	it("is always for a when it cannot read", () => {
		expect(whenOf({ when: { skill: "" } })).toBeUndefined();
		expect(whenOf({ when: "aesthetic" })).toBeUndefined();
		expect(whenOf({})).toBeUndefined();
	});
});
