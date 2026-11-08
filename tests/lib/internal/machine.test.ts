/**
 * This machine's name, as its realm's other machines say it.
 */
import { describe, expect, it } from "vitest";
import { isMachineName, thisMachine } from "../../../lib/internal/machine.ts";

describe("this machine's name", () => {
	it("is its hostname's first label", () => {
		expect(thisMachine("penelope.local")).toBe("penelope");
		expect(thisMachine("aquifer")).toBe("aquifer");
	});

	it("takes only what can be a folder's name and a word on a command line", () => {
		expect(isMachineName("penelope")).toBe(true);
		expect(isMachineName("mac-mini.lan")).toBe(true);
		expect(isMachineName("-o")).toBe(false);
		expect(isMachineName("../penelope")).toBe(false);
		expect(isMachineName("..")).toBe(false);
		expect(isMachineName("")).toBe(false);
		expect(isMachineName(7)).toBe(false);
	});
});
