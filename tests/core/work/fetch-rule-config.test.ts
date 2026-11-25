/**
 * The fetch rule a provider with an exec of its own reads for a
 * checkout, and the words that run a command behind it, through the
 * barrel a provider in another package imports.
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
import { spawnExec } from "../../../lib/core/exec/index.ts";
import {
	behindThrough,
	configuredFetchRule,
} from "../../../lib/core/work/index.ts";

const exec = spawnExec();

let place: string;
let config: string;

beforeEach(() => {
	place = realpathSync(mkdtempSync(join(tmpdir(), "fetch-rule-config-")));
	config = join(place, "config.json");
});

afterEach(() => {
	rmSync(place, { recursive: true, force: true });
});

/** A package config whose `work` section is `work`. */
function configWith(work: unknown): void {
	writeFileSync(config, JSON.stringify({ version: 1, sections: { work } }));
}

describe("the fetch rule a checkout is read with", () => {
	it("reads the rule the section names for the checkout's git folder", async () => {
		configWith({
			fetches: { "/repos/world/git": { through: "exec turn --" } },
		});

		expect(await configuredFetchRule("/repos/world/git", config)).toEqual({
			through: "exec turn --",
		});
		expect(await configuredFetchRule("/repos/other/git", config)).toBe(
			undefined,
		);
	});

	it("reads a rule written through a link by the folder git names", async () => {
		const real = join(place, "store");
		mkdirSync(real);
		symlinkSync(real, join(place, "link"));
		configWith({
			fetches: { [join(place, "link")]: { prefetched: true } },
		});

		expect(await configuredFetchRule(real, config)).toEqual({
			prefetched: true,
		});
	});

	it("reads none from a config that isn't there or can't be parsed", async () => {
		expect(await configuredFetchRule("/repos/world/git", config)).toBe(
			undefined,
		);
		writeFileSync(config, "{ not json");
		expect(await configuredFetchRule("/repos/world/git", config)).toBe(
			undefined,
		);
	});
});

describe("running a command behind a rule", () => {
	it("runs the command inside what the rule's text runs", async () => {
		const ran = await exec(
			"bash",
			behindThrough("exec env RULED=yes", "printenv", ["RULED"]),
		);

		expect(ran).toMatchObject({ code: 0, stdout: "yes\n" });
	});

	it("runs nothing when the rule exits first, as it does during a call", async () => {
		// Shaped as World's rule is: the exit in braces, so the command's
		// words land after the `exec` that would run it.
		const rule = "true && { echo 'a call is on' >&2; exit 75; }; exec env";
		const ran = await exec(
			"bash",
			behindThrough(rule, "touch", [join(place, "ran")]),
		);

		expect(ran).toMatchObject({ code: 75, stderr: "a call is on\n" });
		expect(await exec("test", ["-e", join(place, "ran")])).toMatchObject({
			code: 1,
		});
	});
});
