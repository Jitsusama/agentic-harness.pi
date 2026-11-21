/**
 * The work tool's git speaks English whatever the person's language.
 *
 * git writes the lock it leaves on a tree it is still cutting in the
 * person's language, and the broker tells a killed cut's lock from one
 * a person placed by that word. Under a git speaking French, a killed
 * cut's lock read as a person's, and its tree was refused for good.
 */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetTreeBroker } from "../../../extensions/work-integration/broker.ts";
import workIntegration from "../../../extensions/work-integration/index.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";
import {
	activateWith,
	HEADLESS,
	toolNamed,
} from "../support/review-extension.ts";

let root: string;
let source: string | undefined;
let savedState: string | undefined;
let savedLanguage: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "work-git-english-"));
	savedState = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = join(root, "state");
	savedLanguage = process.env.LANGUAGE;
	forgetTreeBroker();
});
afterEach(async () => {
	forgetTreeBroker();
	if (savedState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedState;
	if (savedLanguage === undefined) delete process.env.LANGUAGE;
	else process.env.LANGUAGE = savedLanguage;
	if (source) await disposeRepo(source);
	source = undefined;
	rmSync(root, { recursive: true, force: true });
});

describe("the git a cut runs", () => {
	it("is told English when the person reads French", async () => {
		// A post-checkout hook runs in git's own environment, so what it
		// reads is what git was told.
		source = await freshRepo("work-english-source");
		await git(source, "branch", "told");
		const heard = join(root, "language");
		const hooks = join(root, "hooks");
		mkdirSync(hooks);
		writeFileSync(
			join(hooks, "post-checkout"),
			`#!/bin/sh\nprintf '%s' "$LANGUAGE" > '${heard}'\n`,
		);
		chmodSync(join(hooks, "post-checkout"), 0o755);
		await git(source, "config", "core.hooksPath", hooks);
		process.env.LANGUAGE = "fr";

		const work = toolNamed(activateWith(workIntegration), "work");
		const cut = (await work.execute(
			"call-1",
			{
				action: "tree",
				repo: "test:english/source",
				checkout: source,
				purpose: "english",
				branch: "told",
			},
			undefined,
			undefined,
			HEADLESS,
		)) as { details?: { ok?: boolean } };

		expect(cut).toMatchObject({ details: { ok: true } });
		expect(readFileSync(heard, "utf8")).toBe("en");
	}, 20_000);
});
