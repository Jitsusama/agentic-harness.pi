/**
 * When asking whether a halted commit already landed has nothing to ask.
 *
 * A landing found and its base side kept are asked through real rebases in
 * `rebase-live.test.ts`; these are the edges that never reach a rebase.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnExec } from "../../../lib/core/exec/index.ts";
import { landedAs } from "../../../lib/core/work/landed.ts";
import { disposeRepo, freshRepo } from "../../support/git-fixture.ts";

let repo: string;

beforeEach(async () => {
	repo = await freshRepo("landed");
});

afterEach(() => {
	disposeRepo(repo);
});

describe("asking where a halted commit landed", () => {
	it("answers nothing outside a halted replay", async () => {
		expect(
			await landedAs(spawnExec(), repo, "main", ["README.md"]),
		).toBeUndefined();
	});

	it("answers nothing when no file is in question", async () => {
		expect(await landedAs(spawnExec(), repo, "main", [])).toBeUndefined();
	});
});
