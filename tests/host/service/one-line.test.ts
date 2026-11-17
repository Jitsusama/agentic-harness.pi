/** A label a model wrote, made one journal line. */
import { describe, expect, it } from "vitest";
import { oneLine } from "../../../host/service/one-line.ts";

describe("oneLine", () => {
	it("leaves a plain label as it is", () => {
		expect(oneLine("j1 subagent: review")).toBe("j1 subagent: review");
	});

	it.each([
		["a line feed", "\n"],
		["a carriage return", "\r"],
		["a NUL, which journald also ends a line at", "\u0000"],
		["an escape, which a terminal reading the journal obeys", "\u001b"],
		["a line separator", "\u2028"],
		["a next line", "\u0085"],
	])("collapses %s into one space", (_, breaking) => {
		expect(oneLine(`j1 shell: nix build${breaking}pi-host: forged`)).toBe(
			"j1 shell: nix build pi-host: forged",
		);
	});

	it("trims what a break leaves at either end", () => {
		expect(oneLine("\n j1 codemode \u0000\r")).toBe("j1 codemode");
	});
});
