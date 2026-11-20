import { parseArgs } from "node:util";
import { describe, expect, it } from "vitest";
import {
	ASKED_WRONGLY,
	asksForHelp,
	CARRY_HELP,
} from "../../../../lib/internal/carry/help.ts";

/** The widest a help line may be, as core's command standard holds. */
const COLUMNS = 72;

describe("pi-carry's help", () => {
	it("opens with its name and keeps each line within 72 columns", () => {
		expect(CARRY_HELP).toMatch(/^pi-carry /);
		const wide = CARRY_HELP.split("\n").filter((line) => line.length > COLUMNS);
		expect(wide).toEqual([]);
	});

	it("names each form the script reads, with each flag it takes", () => {
		const usages = [
			"QUEST --to MACHINE\n",
			"arrive QUEST --from MACHINE --session ID\n",
			"      [--by ADDRESS --why REASON]\n",
			"where QUEST --from MACHINE --session ID\n",
			"fence QUEST --from MACHINE --session ID\n",
			"settle QUEST --session ID\n",
		];
		for (const usage of usages) {
			const line = usage.startsWith(" ") ? usage : `  pi-carry ${usage}`;
			expect(CARRY_HELP).toContain(`\n${line}`);
		}
		for (const form of ["--to", "arrive", "where", "fence", "settle"]) {
			expect(CARRY_HELP).toMatch(new RegExp(`\\n  ${form} +\\S`));
		}
	});

	it("says each code it exits with, as the script gives them", () => {
		expect(CARRY_HELP).toContain(
			"It exits 0 when done, 1 when it couldn't do all it was asked, a line\n" +
				`saying why, and ${ASKED_WRONGLY} when asked wrongly.\n`,
		);
	});

	it("is asked for by --help or -h anywhere before --", () => {
		expect(asksForHelp(["--help"]), "--help alone asks").toBe(true);
		const late = ["arrive", "QEST-20261107-CARRY3", "-h"];
		expect(asksForHelp(late), "-h after a form's words asks").toBe(true);
	});

	it("isn't asked for by a carry's own words", () => {
		const carry = ["QEST-20261107-CARRY3", "--to", "far-machine"];
		expect(asksForHelp(carry), "a carry's words don't ask").toBe(false);
		expect(asksForHelp([]), "no words don't ask").toBe(false);
	});

	it("carries a one-word value, and answers what parseArgs refuses", () => {
		const arrive = ["arrive", "QEST-20261107-CARRY3", "--from", "far"];
		const asked = (...more: string[]) => asksForHelp([...arrive, ...more]);
		// As mycelium sends a reason: one word, which parseArgs carries.
		const reason = asked("--by=WCJQSG", "--why=--help");
		expect(reason, "--why=--help is a reason").toBe(false);
		expect(asked("--why=-h"), "--why=-h is a reason").toBe(false);
		// parseArgs refuses a dash-led value as the next word, so help loses
		// nothing it would have carried.
		expect(asked("--why", "--help"), "a lone --help asks").toBe(true);
	});

	it("rests on parseArgs refusing a dash-led value as the next word", () => {
		const parsed = (...args: string[]) =>
			parseArgs({
				args,
				options: { why: { type: "string" } },
				allowPositionals: true,
			});
		for (const help of ["--help", "-h"]) {
			expect(() => parsed("--why", help)).toThrow(/ambiguous/);
			expect(parsed(`--why=${help}`).values.why).toBe(help);
		}
	});

	it("isn't asked for past --", () => {
		const past = asksForHelp(["--", "--help"]);
		expect(past, "--help past -- is a word").toBe(false);
	});
});
