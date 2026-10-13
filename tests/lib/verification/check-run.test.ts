import { describe, expect, it } from "vitest";
import { checkRunVerdict } from "../../../lib/verification/index.ts";

describe("what a check run says about the code", () => {
	it("is clean when the command passed", () => {
		expect(
			checkRunVerdict({ ok: true, command: "pnpm run test", output: "" }),
		).toEqual({ outcome: "clean" });
	});

	it("is failing when the command ran and found something", () => {
		expect(
			checkRunVerdict({
				ok: false,
				command: "pnpm run test",
				output:
					"Failed (exit 1): pnpm run test\n WARN node_modules missing\nexpected 1 to be 2",
			}),
		).toEqual({ outcome: "failing" });
	});

	it("says nothing when the command could not start", () => {
		const verdict = checkRunVerdict({
			ok: false,
			command: "pnpm run lint",
			output:
				"Failed (exit 1): pnpm run lint\n> biome check .\nsh: line 1: biome: command not found\n ELIFECYCLE  Command failed.",
		});
		expect(verdict).toEqual({
			outcome: "deferred",
			reason: "the check could not start: sh: line 1: biome: command not found",
		});
	});

	it("says nothing when there was no command to run", () => {
		expect(
			checkRunVerdict({ ok: false, output: "No verification command found" }),
		).toEqual({ outcome: "deferred", reason: "no check command was found" });
	});
});
