import { describe, expect, it } from "vitest";
import {
	dependencyStandings,
	describeDrift,
	drifted,
	satisfies,
} from "../../../../lib/internal/install/drift.ts";

describe("a version against a range", () => {
	it("reads a caret by its leftmost non-zero part", () => {
		expect(satisfies("0.6.18", "^0.6.18")).toBe(true);
		expect(satisfies("0.6.15", "^0.6.18")).toBe(false);
		expect(satisfies("0.7.0", "^0.6.18")).toBe(false);
		expect(satisfies("1.40.2", "^1.29.0")).toBe(true);
		expect(satisfies("2.0.0", "^1.29.0")).toBe(false);
		expect(satisfies("0.0.3", "^0.0.3")).toBe(true);
		expect(satisfies("0.0.4", "^0.0.3")).toBe(false);
	});

	it("reads a tilde, an exact version, a floor and anything", () => {
		expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
		expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
		expect(satisfies("1.2.3", "1.2.3")).toBe(true);
		expect(satisfies("1.2.4", "1.2.3")).toBe(false);
		expect(satisfies("9.0.0", ">=1.2.3")).toBe(true);
		expect(satisfies("1.2.2", ">=1.2.3")).toBe(false);
		expect(satisfies("3.1.4", "*")).toBe(true);
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
