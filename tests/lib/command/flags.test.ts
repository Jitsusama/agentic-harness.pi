import { describe, expect, it } from "vitest";
import { findFlag, findFlags, tokenize } from "../../../lib/command/index.js";

const commitSpec = {
	flags: [
		{ name: "message", long: "message", short: "m", takesValue: true },
		{ name: "all", long: "all", short: "a", takesValue: false },
	],
};

describe("findFlags", () => {
	it("returns every occurrence of a repeated flag in order", () => {
		const command = tokenize('git commit -m "a" -m "b"').commands[0];

		const values = findFlags(command, commitSpec, "message").map(
			(m) => m.value,
		);

		expect(values).toEqual(['"a"', '"b"']);
	});

	it("finds a value-taking short flag inside a boolean cluster", () => {
		const command = tokenize('git commit -am "msg"').commands[0];

		const match = findFlags(command, commitSpec, "message")[0];

		expect(match?.value).toBe('"msg"');
	});

	it("finds the boolean member of a cluster", () => {
		const command = tokenize('git commit -am "msg"').commands[0];

		expect(findFlags(command, commitSpec, "all")).toHaveLength(1);
	});

	it("returns nothing when the flag is absent", () => {
		const command = tokenize("git commit --amend").commands[0];

		expect(findFlags(command, commitSpec, "message")).toEqual([]);
	});
});

const bodySpec = {
	flags: [{ name: "body", long: "body", takesValue: true }],
};

const repoSpec = {
	flags: [{ name: "repo", long: "repo", short: "R", takesValue: true }],
};

describe("findFlag", () => {
	it("locates a long flag with a separate value", () => {
		const source = "gh pr create --body hello";
		const command = tokenize(source).commands[0];

		const match = findFlag(command, bodySpec, "body");

		expect(match?.value).toBe("hello");
		const span = match?.valueSpan;
		expect(span && source.slice(span.start, span.end)).toBe("hello");
	});

	it("reads a value joined with equals and spans just the value", () => {
		const source = "gh pr create --repo=shop/world";
		const command = tokenize(source).commands[0];

		const match = findFlag(command, repoSpec, "repo");

		expect(match?.value).toBe("shop/world");
		const span = match?.valueSpan;
		expect(span && source.slice(span.start, span.end)).toBe("shop/world");
	});

	it("locates a short flag value separated by a space", () => {
		const source = "gh pr create -R shop/world";
		const command = tokenize(source).commands[0];

		const match = findFlag(command, repoSpec, "repo");

		expect(match?.value).toBe("shop/world");
		const span = match?.valueSpan;
		expect(span && source.slice(span.start, span.end)).toBe("shop/world");
	});

	it("locates a short flag value attached to the flag", () => {
		const source = "gh pr create -Rshop/world";
		const command = tokenize(source).commands[0];

		const match = findFlag(command, repoSpec, "repo");

		expect(match?.value).toBe("shop/world");
		const span = match?.valueSpan;
		expect(span && source.slice(span.start, span.end)).toBe("shop/world");
	});
});
