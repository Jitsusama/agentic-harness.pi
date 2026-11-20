import { describe, expect, it } from "vitest";
import {
	asksForHelp,
	CARRY_HELP,
} from "../../../../lib/internal/carry/help.ts";

/** The widest a help line may be, as core's command standard holds. */
const COLUMNS = 72;

describe("pi-carry's help", () => {
	it("opens with its name and keeps each line within 72 columns", () => {
		expect(CARRY_HELP.startsWith("pi-carry ")).toBe(true);
		const wide = CARRY_HELP.split("\n").filter((line) => line.length > COLUMNS);
		expect(wide).toEqual([]);
	});

	it("names each form the script reads", () => {
		const usages = [
			"QUEST --to",
			"arrive QUEST",
			"where QUEST",
			"fence QUEST",
			"settle QUEST",
		];
		for (const usage of usages) {
			expect(CARRY_HELP).toContain(`  pi-carry ${usage} `);
		}
	});

	it("is asked for by --help or -h anywhere among the words", () => {
		expect(asksForHelp(["--help"])).toBe(true);
		expect(asksForHelp(["arrive", "QEST-20261107-CARRY3", "-h"])).toBe(true);
	});

	it("isn't asked for by a carry's own words", () => {
		const carry = ["QEST-20261107-CARRY3", "--to", "far-machine"];
		expect(asksForHelp(carry)).toBe(false);
		expect(asksForHelp([])).toBe(false);
	});

	it("reads a valued flag's word as its value, even one spelt as help", () => {
		const arrive = ["arrive", "QEST-20261107-CARRY3", "--from", "far"];
		const asked = (...more: string[]) => asksForHelp([...arrive, ...more]);
		expect(asked("--by", "WCJQSG", "--why", "--help")).toBe(false);
		expect(asked("--why", "-h", "--session", "s")).toBe(false);
		expect(asked("--why", "moved", "--help")).toBe(true);
	});

	it("isn't asked for past --", () => {
		expect(asksForHelp(["--", "--help"])).toBe(false);
	});
});
