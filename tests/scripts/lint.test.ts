/**
 * The lint fails when Biome never ran. On a Mac in Santa's lockdown the
 * platform binary is killed at its start, and Biome's node wrapper
 * takes the kill for success, so `pnpm lint` passed having checked
 * nothing (OSPHT4 [f8cfd1a2], 15 November).
 */

import { describe, expect, it } from "vitest";
import { BIOME_DIDNT_RUN, biomeDidntRun } from "../../scripts/lint.ts";

describe("a lint whose Biome never ran", () => {
	it("fails when Biome was killed, whatever it exited", () => {
		expect(
			biomeDidntRun({ status: null, signal: "SIGKILL", output: "" }),
			"a killed Biome passed",
		).toBe(BIOME_DIDNT_RUN);
	});

	it("fails when Biome exited 0 having said nothing", () => {
		expect(
			biomeDidntRun({ status: 0, signal: null, output: "" }),
			"a silent Biome passed",
		).toBe(BIOME_DIDNT_RUN);
	});

	it("passes Biome's own verdict through when it checked files", () => {
		for (const status of [0, 1])
			expect(
				biomeDidntRun({
					status,
					signal: null,
					output: "Checked 1,904 files in 2s. No fixes applied.\n",
				}),
				`a run that checked files, exiting ${status}, was refused`,
			).toBeUndefined();
		expect(
			biomeDidntRun({
				status: 1,
				signal: null,
				output: "lib/a.ts:1:1 lint/style ━━━\n  × Use const.\n",
			}),
			"Biome's own failure was taken for not running",
		).toBeUndefined();
	});

	it("says where lint runs", () => {
		expect(BIOME_DIDNT_RUN).toContain("optimus");
		expect(BIOME_DIDNT_RUN).toContain("killed or blocked");
	});
});
