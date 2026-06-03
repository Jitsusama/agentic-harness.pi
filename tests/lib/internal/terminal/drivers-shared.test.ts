import { describe, expect, it } from "vitest";
import {
	shellQuote,
	wrapCommandWithEnv,
} from "../../../../lib/internal/terminal/drivers/shared";

describe("shellQuote", () => {
	it("wraps plain strings in single quotes", () => {
		expect(shellQuote("pi")).toBe("'pi'");
	});

	it("escapes single quotes the POSIX way", () => {
		expect(shellQuote("a'b")).toBe("'a'\\''b'");
	});

	it("preserves spaces and metacharacters inside the quotes", () => {
		expect(shellQuote("hello world $PATH")).toBe("'hello world $PATH'");
	});
});

describe("wrapCommandWithEnv", () => {
	it("returns the command unchanged when env is undefined", () => {
		expect(wrapCommandWithEnv("pi", undefined)).toBe("pi");
	});

	it("returns the command unchanged when env is empty", () => {
		expect(wrapCommandWithEnv("pi", {})).toBe("pi");
	});

	it("prepends KEY=value assignments and execs the command", () => {
		expect(
			wrapCommandWithEnv("pi", { QUEST_WORKFLOW_AUTOLOAD_ID: "QEST-X" }),
		).toBe("QUEST_WORKFLOW_AUTOLOAD_ID='QEST-X' exec pi");
	});

	it("quotes env values that contain spaces", () => {
		expect(wrapCommandWithEnv("pi", { TITLE: "a b" })).toBe(
			"TITLE='a b' exec pi",
		);
	});

	it("supports multiple env vars in declaration order", () => {
		expect(wrapCommandWithEnv("pi", { A: "1", B: "2" })).toBe(
			"A='1' B='2' exec pi",
		);
	});

	it("escapes single quotes in env values", () => {
		expect(wrapCommandWithEnv("pi", { TITLE: "Joel's quest" })).toBe(
			"TITLE='Joel'\\''s quest' exec pi",
		);
	});
});
