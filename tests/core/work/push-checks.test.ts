/**
 * The push checks the `work` section names, and the one a checkout is
 * read with. An entry written wrong is reported and left out, since a
 * section written wrong pushes as it always did.
 */

import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	configuredPushCheck,
	DEFAULT_CHECK_SECONDS,
	MOST_CHECK_SECONDS,
	parseWorkPushChecks,
} from "../../../lib/core/work/push-checks.ts";

describe("the push checks a work section names", () => {
	it("takes a check by its git folder, with its seconds", () => {
		const parsed = parseWorkPushChecks({
			pushChecks: { "/w/.git/": { run: "bash tools/fast.sh", seconds: 60 } },
		});

		expect(parsed).toEqual({
			checks: { "/w/.git": { run: "bash tools/fast.sh", seconds: 60 } },
			problems: [],
		});
	});

	it("runs a check for the default time when it names none", () => {
		const parsed = parseWorkPushChecks({
			pushChecks: { "/w/.git": { run: "make fast" } },
		});

		expect(parsed.checks["/w/.git"]).toEqual({
			run: "make fast",
			seconds: DEFAULT_CHECK_SECONDS,
		});
		expect(DEFAULT_CHECK_SECONDS).toBe(300);
	});

	it("runs a check asking for longer than the most for the most, saying so", () => {
		const parsed = parseWorkPushChecks({
			pushChecks: { "/w/.git": { run: "make all", seconds: 3600 } },
		});

		expect(parsed.checks["/w/.git"]).toEqual({
			run: "make all",
			seconds: MOST_CHECK_SECONDS,
		});
		expect(MOST_CHECK_SECONDS).toBe(900);
		expect(parsed.problems).toEqual([
			"work.pushChecks./w/.git: seconds is past 900, so it runs for 900.",
		]);
	});

	it("leaves out a check with no run, or a blank one", () => {
		const parsed = parseWorkPushChecks({
			pushChecks: {
				"/a/.git": { seconds: 60 },
				"/b/.git": { run: "  " },
				"/c/.git": { run: 7 },
			},
		});

		expect(parsed.checks).toEqual({});
		expect(parsed.problems).toEqual([
			"work.pushChecks./a/.git: run is not shell text.",
			"work.pushChecks./b/.git: run is not shell text.",
			"work.pushChecks./c/.git: run is not shell text.",
		]);
	});

	it("leaves out a check whose seconds isn't a whole number above 0", () => {
		const parsed = parseWorkPushChecks({
			pushChecks: {
				"/a/.git": { run: "x", seconds: "60" },
				"/b/.git": { run: "x", seconds: 0 },
				"/c/.git": { run: "x", seconds: 1.5 },
				"/d/.git": { run: "x", seconds: -60 },
			},
		});

		expect(parsed.checks).toEqual({});
		expect(parsed.problems).toHaveLength(4);
		for (const problem of parsed.problems) {
			expect(problem).toContain("seconds is not a whole number");
		}
	});

	it("leaves out a check keyed by a relative folder", () => {
		const parsed = parseWorkPushChecks({
			pushChecks: { "repo/.git": { run: "make fast" } },
		});

		expect(parsed.checks).toEqual({});
		expect(parsed.problems).toEqual([
			"work.pushChecks.repo/.git: not an absolute git folder.",
		]);
	});

	it("names none for a section with none, and reports one written wrong", () => {
		expect(parseWorkPushChecks(undefined)).toEqual({
			checks: {},
			problems: [],
		});
		expect(parseWorkPushChecks({ fetches: {} })).toEqual({
			checks: {},
			problems: [],
		});
		expect(parseWorkPushChecks({ pushChecks: [] }).problems).toEqual([
			"work.pushChecks: not an object of git folders.",
		]);
		expect(parseWorkPushChecks("work").problems).toEqual([
			"work: the section is not an object.",
		]);
	});
});

describe("the push check a checkout is read with", () => {
	let place: string;
	let config: string;

	beforeEach(() => {
		place = realpathSync(mkdtempSync(join(tmpdir(), "push-checks-")));
		config = join(place, "config.json");
	});

	afterEach(() => {
		rmSync(place, { recursive: true, force: true });
	});

	/** A package config whose `work` section is `work`. */
	function configWith(work: unknown): void {
		writeFileSync(config, JSON.stringify({ version: 1, sections: { work } }));
	}

	it("reads the check named for the git folder, through a link or a trailing slash", async () => {
		// A near miss would push unchecked and say nothing, so the folder
		// is matched as a fetch rule's is.
		const real = join(place, "store");
		mkdirSync(real);
		symlinkSync(real, join(place, "link"));
		configWith({ pushChecks: { [join(place, "link")]: { run: "make fast" } } });

		for (const asked of [real, `${real}/`, join(place, "link")]) {
			expect(await configuredPushCheck(asked, config), asked).toEqual({
				run: "make fast",
				seconds: DEFAULT_CHECK_SECONDS,
			});
		}
		expect(await configuredPushCheck("/repos/other/.git", config)).toBe(
			undefined,
		);
	});

	it("reads none from a config that isn't there or can't be parsed", async () => {
		expect(await configuredPushCheck("/repos/world/.git", config)).toBe(
			undefined,
		);
		writeFileSync(config, "{ not json");
		expect(await configuredPushCheck("/repos/world/.git", config)).toBe(
			undefined,
		);
	});
});
