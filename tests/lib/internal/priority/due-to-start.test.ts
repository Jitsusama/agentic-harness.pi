import { describe, expect, it } from "vitest";
import {
	DUE_WITHIN_MS,
	dueBy,
	dueToStartOf,
} from "../../../../lib/internal/priority/due-to-start.ts";
import {
	JOINS_FOR_MS,
	PASS_AFTER_MS,
	QUICK_OUTRUN_MS,
	VM_SETTLE_MS,
} from "../../../../lib/internal/priority/queue.ts";
import { job, NOW } from "./queue-line.ts";

/** A build asked at {@link NOW}. */
const asked = job("j", { since: new Date(NOW).toISOString() });

/** Epoch seconds an hour past {@link NOW}, as `date +%s` would say them. */
const IN_AN_HOUR_S = NOW / 1000 + 3600;

describe("when a queued job is due to start", () => {
	const home = "/home/j";
	const where = { cwd: `${home}/src/core.nix`, home };

	it("reads epoch seconds or minutes from now, set for the heavy step", () => {
		expect(
			dueToStartOf(`PI_DUE_TO_START=${IN_AN_HOUR_S} cargo build`, asked, where),
		).toBe(IN_AN_HOUR_S * 1000);
		expect(dueToStartOf("PI_DUE_TO_START=+15 cargo build", asked, where)).toBe(
			NOW + 15 * 60_000,
		);
		expect(
			dueToStartOf("env PI_DUE_TO_START=+2 cargo test", asked, where),
		).toBe(NOW + 2 * 60_000);
	});

	it("reads it exported earlier in the command, or from the shell", () => {
		expect(
			dueToStartOf(
				"export PI_DUE_TO_START=+30; cd x && cargo build",
				asked,
				where,
			),
		).toBe(NOW + 30 * 60_000);
		expect(dueToStartOf("cargo build", asked, where, "+5")).toBe(
			NOW + 5 * 60_000,
		);
		expect(
			dueToStartOf("PI_DUE_TO_START=+1 cargo build", asked, where, "+5"),
		).toBe(NOW + 60_000);
		// A plain assignment reaches the command only once exported.
		expect(
			dueToStartOf("PI_DUE_TO_START=+1; cargo build", asked, where, "+5"),
		).toBe(NOW + 60_000);
		expect(dueToStartOf("PI_DUE_TO_START=+1; cargo build", asked, where)).toBe(
			NOW + PASS_AFTER_MS,
		);
		expect(
			dueToStartOf("unset PI_DUE_TO_START; cargo build", asked, where, "+5"),
		).toBe(NOW + PASS_AFTER_MS);
	});

	it("is its kind's bound past asking without one, or with one it can't read", () => {
		expect(dueToStartOf("cargo build", asked, where)).toBe(NOW + PASS_AFTER_MS);
		// A bare number is minutes forgotten their plus, or a stamp in
		// milliseconds: neither is ten digits of epoch seconds.
		const bare = ["15", "179000000", `${IN_AN_HOUR_S}000`];
		for (const bad of [
			"soon",
			"+",
			"-5",
			"+1.5",
			"1e9",
			"$WHEN",
			"",
			...bare,
		]) {
			expect(
				dueToStartOf(`PI_DUE_TO_START=${bad} cargo build`, asked, where),
				bad,
			).toBe(NOW + PASS_AFTER_MS);
		}
		// Set for another command, it never reaches the heavy one.
		expect(
			dueToStartOf("PI_DUE_TO_START=+1 true; cargo build", asked, where),
		).toBe(NOW + PASS_AFTER_MS);
	});

	it("gives each kind the bound its own rules wait for", () => {
		expect(DUE_WITHIN_MS).toEqual({
			"vm-test": VM_SETTLE_MS,
			"vm-check": VM_SETTLE_MS,
			benchmark: PASS_AFTER_MS,
			build: PASS_AFTER_MS,
			"world-walk": JOINS_FOR_MS,
			stamp: PASS_AFTER_MS,
			"timed-run": PASS_AFTER_MS,
		});
		const walk = { ...asked, kind: "world-walk" as const };
		expect(dueBy(walk)).toBe(NOW + JOINS_FOR_MS);
		const quick = { ...asked, quick: true as const };
		expect(dueBy(quick)).toBe(NOW + QUICK_OUTRUN_MS);
	});

	it("gives a job an older harness wrote, with none, its kind's bound", () => {
		// What a job file without the field reads back as.
		const old = JSON.parse(JSON.stringify(asked));
		expect(old.dueToStart).toBeUndefined();
		expect(dueBy(old)).toBe(NOW + PASS_AFTER_MS);
		expect(dueBy({ ...asked, dueToStart: NOW + 1 })).toBe(NOW + 1);
	});
});
