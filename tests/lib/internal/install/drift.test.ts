import { describe, expect, it } from "vitest";
import {
	dependencyStandings,
	describeDrift,
	drifted,
	satisfies,
} from "../../../../lib/internal/install/drift.ts";

describe("a version against a range", () => {
	it("reads a caret by its leftmost non-zero part", () => {
		expect(
			satisfies("0.6.18", "^0.6.18"),
			"the version a caret names is in it",
		).toBe(true);
		expect(
			satisfies("0.6.15", "^0.6.18"),
			"a patch below the caret's floor is out",
		).toBe(false);
		expect(
			satisfies("0.7.0", "^0.6.18"),
			"a new minor is out when the caret's leftmost non-zero part is the minor",
		).toBe(false);
		expect(
			satisfies("1.40.2", "^1.29.0"),
			"a later minor is in when the caret's leftmost non-zero part is the major",
		).toBe(true);
		expect(satisfies("2.0.0", "^1.29.0"), "a new major is out of ^1.29.0").toBe(
			false,
		);
		expect(
			satisfies("0.0.3", "^0.0.3"),
			"the version a caret names is in it, even at 0.0",
		).toBe(true);
		expect(
			satisfies("0.0.4", "^0.0.3"),
			"a new patch is out when the caret's leftmost non-zero part is the patch",
		).toBe(false);
	});

	it("reads a tilde, an exact version, a floor and anything", () => {
		expect(satisfies("1.2.9", "~1.2.3"), "a later patch is in a tilde").toBe(
			true,
		);
		expect(satisfies("1.3.0", "~1.2.3"), "a new minor is out of a tilde").toBe(
			false,
		);
		expect(satisfies("1.2.3", "1.2.3"), "an exact version is in itself").toBe(
			true,
		);
		expect(
			satisfies("1.2.4", "1.2.3"),
			"any other version is out of an exact one",
		).toBe(false);
		expect(
			satisfies("9.0.0", ">=1.2.3"),
			"any later major is above a floor",
		).toBe(true);
		expect(
			satisfies("1.2.2", ">=1.2.3"),
			"a version below a floor is out",
		).toBe(false);
		expect(satisfies("3.1.4", "*"), "any version is in a star").toBe(true);
	});

	it("will not guess at a shape it does not read", () => {
		expect(satisfies("1.2.3", "github:owner/repo")).toBeUndefined();
		expect(satisfies("1.2.3", "^1.2")).toBeUndefined();
		expect(satisfies("1.2.3-beta.1", "^1.2.0")).toBeUndefined();
		expect(satisfies("1.2.3", "1.x || 2.x")).toBeUndefined();
	});
});

describe("a package's dependencies", () => {
	const installed: Record<string, string> = {
		core: "0.6.15",
		yaml: "2.9.1",
		odd: "1.0.0",
	};
	const standings = dependencyStandings(
		{ core: "^0.6.18", yaml: "^2.9.0", gone: "^1.0.0", odd: "file:../odd" },
		(name) => installed[name],
	);

	it("stands each one against its range", () => {
		expect(standings.map((s) => [s.name, s.verdict])).toEqual([
			["core", "outside"],
			["yaml", "satisfied"],
			["gone", "missing"],
			["odd", "unchecked"],
		]);
	});

	it("names only the ones that drifted, with what each wants", () => {
		expect(describeDrift(drifted(standings))).toBe(
			"core 0.6.15 (wants ^0.6.18); gone is not installed (wants ^1.0.0)",
		);
	});
});
