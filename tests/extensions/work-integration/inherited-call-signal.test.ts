/**
 * The work tool's git answers to its own call, not one it inherited.
 *
 * Whatever kicks a turn passes on its async context, so a turn begun
 * from inside a review call runs inside that call, which may still be
 * running long after its signal fired. Read as the work call's own,
 * that fired signal refused every git the work tool ran, as "git
 * aborted before it started", until the session restarted (H2VYOB,
 * 17 November), while plain git in bash went on working.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetTreeBroker } from "../../../extensions/work-integration/broker.ts";
import workIntegration from "../../../extensions/work-integration/index.ts";
import { withCallSignal } from "../../../lib/core/exec/call-signal.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";
import {
	activateWith,
	HEADLESS,
	toolNamed,
} from "../support/review-extension.ts";

/** A promise that settles when the test says, and the way to say it. */
function gate(): { opened: Promise<void>; open: () => void } {
	let open = (): void => undefined;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

/** What a work call answers, as far as these tests read it. */
interface Answered {
	content?: { text?: string }[];
	details?: { ok?: boolean; key?: string; path?: string };
}

let root: string;
let seed: string | undefined;
let checkout: string;
let savedState: string | undefined;
let savedHome: string | undefined;

beforeEach(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "work-inherited-signal-")));
	savedState = process.env.XDG_STATE_HOME;
	savedHome = process.env.HOME;
	forgetTreeBroker();
	// pi runs git in a tree it cuts only when the tree's repository is
	// one the fence guards, a checkout under the home's src.
	seed = await freshRepo("work-inherited-seed");
	checkout = join(root, "src", "inherited");
	await git(root, "clone", "-q", seed, checkout);
	process.env.HOME = root;
	process.env.XDG_STATE_HOME = join(root, "state");
});
afterEach(async () => {
	forgetTreeBroker();
	if (savedState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedState;
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	if (seed) await disposeRepo(seed);
	seed = undefined;
	rmSync(root, { recursive: true, force: true });
});

describe("a work call made inside another call whose signal fired", () => {
	it("makes its branch, since only its own signal can stop its git", async () => {
		const stub = activateWith(workIntegration);
		const work = toolNamed(stub, "work");
		const { signal } = new AbortController();
		const cut = (await work.execute(
			"call-1",
			{
				action: "tree",
				repo: "test:inherited/source",
				checkout,
				purpose: "inherited",
				branch: "inherited",
			},
			signal,
			undefined,
			HEADLESS,
		)) as Answered;
		expect(cut).toMatchObject({ details: { ok: true } });

		// A review call still running, whose signal fired, kicks the turn
		// the work call is made in.
		const review = new AbortController();
		const reviewEnds = gate();
		const turnStarts = gate();
		let branched: Promise<Answered> | undefined;
		const reviewing = withCallSignal(review.signal, async () => {
			branched = turnStarts.opened.then(
				() =>
					work.execute(
						"call-2",
						{ action: "branch", tree: cut.details?.key, name: "made-here" },
						signal,
						undefined,
						HEADLESS,
					) as Promise<Answered>,
			);
			await reviewEnds.opened;
		});
		review.abort();
		turnStarts.open();

		const answer = await branched;
		reviewEnds.open();
		await reviewing;

		const said = answer?.content?.map((part) => part.text).join("\n") ?? "";
		expect(said).not.toContain("aborted before it started");
		expect(answer).toMatchObject({ details: { ok: true } });
		const path = cut.details?.path ?? "";
		expect((await git(path, "branch", "--show-current")).trim()).toBe(
			"made-here",
		);
	}, 20_000);
});
