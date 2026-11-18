/**
 * The work tool's git answers to its own call, not one it inherited.
 *
 * Whatever kicks a turn passes on its async context, so a turn begun
 * from inside a review call runs inside that call, which may still be
 * running long after its signal fired. Read as the work call's own,
 * that fired signal refused every git the work tool ran, as "git
 * aborted before it started", until the session restarted (H2VYOB,
 * 17 November), while plain git in bash went on working.
 *
 * Run against real repositories, a bare origin and a clone under the
 * home's src, since what is checked is that real git runs.
 */

import {
	existsSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetTreeBroker } from "../../../extensions/work-integration/broker.ts";
import workIntegration from "../../../extensions/work-integration/index.ts";
import { withCallSignal } from "../../../lib/core/exec/index.ts";
import {
	type TreeClaims,
	WORK_TREE_CLAIMS,
} from "../../../lib/core/work/index.ts";
import {
	announceJobHost,
	type Job,
	type JobHost,
	type JobOutcome,
} from "../../../lib/jobs/host.ts";
import {
	disposeRepo,
	freshRepo,
	git,
	REAL_GIT_MS,
} from "../../support/git-fixture.ts";
import { until } from "../../support/until.ts";
import {
	activateWith,
	HEADLESS,
	toolNamed,
} from "../support/review-extension.ts";

/** How long real git gets to reach the hook, or to finish once let go. */
const GIT_WITHIN_MS = 10_000;

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

/** What an answer says, its parts joined. */
function saidBy(answer: Answered | undefined): string {
	return answer?.content?.map((part) => part.text).join("\n") ?? "";
}

/**
 * Make a work call from inside a review call that is still running and
 * whose signal has fired, as a turn that call kicked makes it.
 */
async function insideAFiredCall(
	call: () => Promise<Answered>,
): Promise<Answered> {
	const review = new AbortController();
	const reviewEnds = gate();
	const turnStarts = gate();
	let made: Promise<Answered> | undefined;
	const reviewing = withCallSignal(review.signal, async () => {
		made = turnStarts.opened.then(call);
		await reviewEnds.opened;
	});
	review.abort();
	turnStarts.open();
	try {
		if (!made) throw new Error("the review call never made the work call");
		return await made;
	} finally {
		reviewEnds.open();
		await reviewing;
	}
}

let root: string;
let seed: string | undefined;
let clone: string;
let savedState: string | undefined;
let savedHome: string | undefined;

beforeEach(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "work-inherited-signal-")));
	savedState = process.env.XDG_STATE_HOME;
	savedHome = process.env.HOME;
	forgetTreeBroker();
	seed = await freshRepo("work-inherited-seed");
	const origin = join(root, "origin.git");
	// pi runs git in a tree it holds only when the tree's repository is
	// one the fence guards, a checkout under the home's src.
	clone = join(root, "src", "clone");
	process.env.HOME = root;
	process.env.XDG_STATE_HOME = join(root, "state");
	await git(root, "clone", "-q", "--bare", seed, origin);
	await git(root, "clone", "-q", origin, clone);
	await git(clone, "config", "user.email", "test@example.com");
	await git(clone, "config", "user.name", "Test");
	await git(clone, "config", "commit.gpgsign", "false");
	await git(clone, "switch", "-q", "-c", "topic");
	writeFileSync(join(clone, "topic.md"), "topic\n");
	await git(clone, "add", "topic.md");
	await git(clone, "commit", "-qm", "topic");
});
afterEach(async () => {
	vi.useRealTimers();
	forgetTreeBroker();
	if (savedState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedState;
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	if (seed) await disposeRepo(seed);
	seed = undefined;
	rmSync(root, { recursive: true, force: true });
});

/** A job host that keeps what each job finished with. */
function recordingHost(): { host: JobHost; outcomes: JobOutcome[] } {
	const outcomes: JobOutcome[] = [];
	const host: JobHost = {
		start: (): Job => ({
			id: "j7",
			signal: new AbortController().signal,
			finish: (outcome) => outcomes.push(outcome),
			onDelivered: () => undefined,
			withdraw: () => false,
		}),
	};
	return { host, outcomes };
}

describe("a work call made inside another call whose signal fired", () => {
	it("makes its branch, unstopped by the signal it inherited", async () => {
		const stub = activateWith(workIntegration);
		const work = toolNamed(stub, "work");
		const { signal } = new AbortController();
		const cut = (await work.execute(
			"call-1",
			{
				action: "tree",
				repo: "test:inherited/source",
				checkout: clone,
				purpose: "inherited",
				branch: "inherited",
			},
			signal,
			undefined,
			HEADLESS,
		)) as Answered;
		expect(cut).toMatchObject({ details: { ok: true } });

		const answer = await insideAFiredCall(
			() =>
				work.execute(
					"call-2",
					{ action: "branch", tree: cut.details?.key, name: "made-here" },
					signal,
					undefined,
					HEADLESS,
				) as Promise<Answered>,
		);

		expect(saidBy(answer)).not.toContain("aborted before it started");
		expect(answer).toMatchObject({ details: { ok: true } });
		const path = cut.details?.path ?? "";
		expect(await git(path, "branch", "--show-current")).toBe("made-here");
	}, 20_000);

	it(
		"finishes a push moved to a job, whose git runs after the call returned",
		async () => {
			// Held at the pre-push hook until the call has handed off, so the
			// git after the push runs once the call is over.
			const started = join(root, "started");
			const release = join(root, "release");
			writeFileSync(
				join(clone, ".git", "hooks", "pre-push"),
				`#!/bin/sh\n: > '${started}'\nwhile [ ! -e '${release}' ] && [ -d '${root}' ]; do sleep 0.05; done\n`,
				{ mode: 0o755 },
			);
			const { host, outcomes } = recordingHost();
			const stub = activateWith(workIntegration);
			stub.pi.events.on(WORK_TREE_CLAIMS, (data) => {
				(data as TreeClaims).paths.push(clone);
			});
			announceJobHost(stub.pi.events as never, host);
			const work = toolNamed(stub, "work");
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

			const answer = await insideAFiredCall(async () => {
				const returned = work.execute(
					"call-1",
					{ action: "push", tree: clone },
					new AbortController().signal,
					undefined,
					HEADLESS,
				) as Promise<Answered>;
				const deadline = Date.now() + GIT_WITHIN_MS;
				while (!existsSync(started) && Date.now() < deadline) {
					await new Promise((resolve) => setImmediate(resolve));
				}
				expect(existsSync(started), "git reached the pre-push hook").toBe(true);
				await vi.advanceTimersByTimeAsync(60_000);
				return returned;
			});
			expect(saidBy(answer)).toContain("now runs as background work j7");
			vi.useRealTimers();
			writeFileSync(release, "");
			await until(
				"the push to finish",
				() => outcomes.length > 0,
				GIT_WITHIN_MS,
			);

			expect(outcomes[0]?.summary).not.toContain("aborted before it started");
			expect(outcomes[0]?.summary).toContain("topic published to origin");
		},
		REAL_GIT_MS,
	);
});
