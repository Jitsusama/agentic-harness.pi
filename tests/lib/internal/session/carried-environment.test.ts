import { describe, expect, it } from "vitest";
import {
	asCarriedEnvironment,
	carriedEnvironment,
} from "../../../../lib/internal/session/carried-environment.ts";
import { holderCommand } from "../../../../lib/internal/session/park.ts";

describe("the environment a session carries back", () => {
	it("keeps the fence's and the spawner's settings, and nothing else", () => {
		expect(
			carriedEnvironment({
				PI_SANDBOX: "fence",
				PI_SPAWNER: "on",
				HOME: "/home/me",
			}),
		).toEqual({ PI_SANDBOX: "fence", PI_SPAWNER: "on" });
	});

	it("is nothing for a session started without either", () => {
		expect(carriedEnvironment({ HOME: "/home/me" })).toBeUndefined();
		expect(carriedEnvironment({ PI_SANDBOX: "" })).toBeUndefined();
	});

	it("leaves behind a value that isn't a plain word", () => {
		// The launcher puts these in a command line, so a value that could
		// say more than a setting never reaches it.
		expect(
			carriedEnvironment({ PI_SANDBOX: "fence; rm -rf ~", PI_SPAWNER: "on" }),
		).toEqual({ PI_SPAWNER: "on" });
	});

	it("reads back only the carried variables, each a plain word", () => {
		expect(asCarriedEnvironment({ PI_SANDBOX: "fence" })).toEqual({
			PI_SANDBOX: "fence",
		});
		for (const stored of [
			{ PATH: "/bin" },
			{ PI_SANDBOX: "a b" },
			{ PI_SANDBOX: 1 },
			{},
			["PI_SANDBOX=fence"],
			"PI_SANDBOX=fence",
			null,
		]) {
			expect(asCarriedEnvironment(stored), JSON.stringify(stored)).toBe(
				undefined,
			);
		}
	});

	it("puts a holder's restart behind env with them", () => {
		expect(
			holderCommand("/s.jsonl", [], { PI_SANDBOX: "fence", PI_SPAWNER: "on" }),
		).toEqual([
			"env",
			"PI_SANDBOX=fence",
			"PI_SPAWNER=on",
			"pi",
			"--session",
			"/s.jsonl",
		]);
		expect(holderCommand("/s.jsonl", [], {})).toEqual([
			"pi",
			"--session",
			"/s.jsonl",
		]);
	});
});
