import { describe, expect, it } from "vitest";
import { findFlag, tokenize } from "../../../lib/command/index.js";

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
