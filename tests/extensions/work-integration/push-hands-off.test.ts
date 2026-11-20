/**
 * A push still running after a minute moves to a job, so the turn that
 * asked for it is free to hear the person again.
 *
 * Run against real repositories, a bare origin and a clone, with a
 * pre-push hook that holds the push until the test lets it go, since
 * what is checked is that real git keeps running behind the job.
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

let seed: string;
let place: string;
let clone: string;
let savedState: string | undefined;
let savedHome: string | undefined;

beforeEach(async () => {
	savedState = process.env.XDG_STATE_HOME;
	savedHome = process.env.HOME;
	forgetTreeBroker();
	seed = await freshRepo("push-hands-off-seed");
	place = realpathSync(mkdtempSync(join(tmpdir(), "push-hands-off-")));
	const origin = join(place, "origin.git");
	// pi runs git in a tree it holds only when the tree's repository is one
	// the fence guards, a checkout under the home's src.
	clone = join(place, "src", "clone");
	process.env.HOME = place;
	process.env.XDG_STATE_HOME = join(place, "state");
	await git(place, "clone", "-q", "--bare", seed, origin);
	await git(place, "clone", "-q", origin, clone);
	await git(clone, "config", "user.email", "test@example.com");
	await git(clone, "config", "user.name", "Test");
	await git(clone, "config", "commit.gpgsign", "false");
	await git(clone, "switch", "-q", "-c", "topic");
	writeFileSync(join(clone, "topic.md"), "topic\n");
	await git(clone, "add", "topic.md");
	await git(clone, "commit", "-qm", "topic");
});

afterEach(() => {
	vi.useRealTimers();
	forgetTreeBroker();
	if (savedState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedState;
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	disposeRepo(seed);
	rmSync(place, { recursive: true, force: true });
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

/**
 * Hold every push from the clone until `release` exists, saying it has
 * begun by making `started`. The hook's own sleep is git's child polling
 * for the file, so the test's clock never waits on it. It also lets go
 * once the test's folder is gone, so a failed run leaves nothing behind.
 * With `says`, the hook says it on stderr first, as World's push gate
 * says a push waits its turn.
 */
function holdPushes(says?: string): { started: string; release: string } {
	const started = join(place, "started");
	const release = join(place, "release");
	const hook = join(clone, ".git", "hooks", "pre-push");
	const said = says === undefined ? "" : `echo '${says}' >&2\n`;
	writeFileSync(
		hook,
		`#!/bin/sh\n${said}: > '${started}'\nwhile [ ! -e '${release}' ] && [ -d '${place}' ]; do sleep 0.05; done\n`,
		{ mode: 0o755 },
	);
	return { started, release };
}

/**
 * Hold every fetch into the clone the same way, through the program git
 * runs on the remote's side of a fetch, which for a local remote is a
 * command the clone names.
 */
async function holdFetches(): Promise<{ started: string; release: string }> {
	const started = join(place, "fetch-started");
	const release = join(place, "fetch-release");
	const wrapper = join(place, "held-upload-pack");
	writeFileSync(
		wrapper,
		`#!/bin/sh\n: > '${started}'\nwhile [ ! -e '${release}' ] && [ -d '${place}' ]; do sleep 0.05; done\nexec git-upload-pack "$@"\n`,
		{ mode: 0o755 },
	);
	await git(clone, "config", "remote.origin.uploadpack", wrapper);
	return { started, release };
}

/** Let I/O turns pass until `ready` holds or the time is up. */
async function turnsUntil(ready: () => boolean): Promise<void> {
	const deadline = Date.now() + GIT_WITHIN_MS;
	while (!ready() && Date.now() < deadline) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

describe("a branch whose fetch is waited on", () => {
	it(
		"still fetching after a minute moves to a job, which says where the branch starts",
		async () => {
			// Origin's main moves on while this clone's record of it stays
			// behind, so the branch lands on the new commit only if the fetch
			// finished behind the job rather than being stopped by it.
			const behind = await git(clone, "rev-parse", "origin/main");
			await git(clone, "push", "-q", "origin", "topic:main");
			await git(clone, "update-ref", "refs/remotes/origin/main", behind);
			const moved = await git(clone, "rev-parse", "topic");
			const { started, release } = await holdFetches();
			const { host, outcomes } = recordingHost();
			const stub = activateWith(workIntegration);
			stub.pi.events.on(WORK_TREE_CLAIMS, (data) => {
				(data as TreeClaims).paths.push(clone);
			});
			announceJobHost(stub.pi.events as never, host);
			const work = toolNamed(stub, "work");
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			let returned = false;
			const answer = (
				work.execute(
					"call-2",
					{
						action: "branch",
						tree: clone,
						name: "jg/next",
						from: "origin/main",
					},
					undefined,
					undefined,
					HEADLESS,
				) as Promise<{ content: { text: string }[] }>
			).finally(() => {
				returned = true;
			});
			try {
				await turnsUntil(() => existsSync(started));
				expect(existsSync(started), "git began the fetch").toBe(true);
				await vi.advanceTimersByTimeAsync(60_000);
				await turnsUntil(() => returned);
				expect(returned, "the call gave the turn back after a minute").toBe(
					true,
				);
				const said = (await answer).content.map((part) => part.text).join("\n");
				expect(said).toContain("now runs as background work j7");
			} finally {
				vi.useRealTimers();
				writeFileSync(release, "");
			}
			await until(
				"the branch to be made",
				() => outcomes.length > 0,
				GIT_WITHIN_MS,
			);
			expect(outcomes[0]?.summary).toContain("is on jg/next");
			expect(await git(clone, "branch", "--show-current")).toBe("jg/next");
			expect(await git(clone, "rev-parse", "jg/next")).toBe(moved);
			expect(outcomes[0]?.summary).toContain(`at ${moved.slice(0, 12)}`);
		},
		REAL_GIT_MS,
	);
});

describe("a push waited on", () => {
	it(
		"still running after a minute moves to a job, which says how it ended",
		async () => {
			const { started, release } = holdPushes();
			const { host, outcomes } = recordingHost();
			const stub = activateWith(workIntegration);
			stub.pi.events.on(WORK_TREE_CLAIMS, (data) => {
				(data as TreeClaims).paths.push(clone);
			});
			announceJobHost(stub.pi.events as never, host);
			const work = toolNamed(stub, "work");
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const returned = work.execute(
				"call-1",
				{ action: "push", tree: clone },
				undefined,
				undefined,
				HEADLESS,
			) as Promise<{ content: { text: string }[] }>;
			// The push reads the tree and asks for objections before git runs
			// the hook, so the clock moves only once the hook has begun. Waited
			// on by I/O turns, since the timers are the test's.
			const deadline = Date.now() + GIT_WITHIN_MS;
			while (!existsSync(started) && Date.now() < deadline) {
				await new Promise((resolve) => setImmediate(resolve));
			}
			expect(existsSync(started), "git reached the pre-push hook").toBe(true);
			await vi.advanceTimersByTimeAsync(60_000);
			const said = (await returned).content.map((part) => part.text).join("\n");
			expect(said).toContain("now runs as background work j7");
			vi.useRealTimers();
			writeFileSync(release, "");
			await until(
				"the push to finish",
				() => outcomes.length > 0,
				GIT_WITHIN_MS,
			);
			expect(outcomes[0]?.summary).toContain("topic published to origin");
			expect(await git(clone, "rev-parse", "origin/topic")).toBe(
				await git(clone, "rev-parse", "topic"),
			);
		},
		REAL_GIT_MS,
	);

	it(
		"held by World's push gate past the unattended clock, still publishes",
		async () => {
			const { started, release } = holdPushes(
				"world-push-gate: another push to World is running; this one waits its turn.",
			);
			const { host, outcomes } = recordingHost();
			const stub = activateWith(workIntegration);
			stub.pi.events.on(WORK_TREE_CLAIMS, (data) => {
				(data as TreeClaims).paths.push(clone);
			});
			announceJobHost(stub.pi.events as never, host);
			const work = toolNamed(stub, "work");
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const returned = work.execute(
				"call-3",
				{ action: "push", tree: clone },
				undefined,
				undefined,
				HEADLESS,
			) as Promise<{ content: { text: string }[] }>;
			await turnsUntil(() => existsSync(started));
			expect(existsSync(started), "git reached the pre-push hook").toBe(true);
			// The gate's line was said before the hook marked it began; a few
			// more I/O turns let the push's clock hear it.
			for (let turn = 0; turn < 50; turn++) {
				await new Promise((resolve) => setImmediate(resolve));
			}
			// Eleven minutes, past the unattended clock's ten.
			await vi.advanceTimersByTimeAsync(11 * 60_000);
			await returned;
			vi.useRealTimers();
			writeFileSync(release, "");
			await until(
				"the push to finish",
				() => outcomes.length > 0,
				GIT_WITHIN_MS,
			);
			expect(
				outcomes[0]?.summary,
				"a push the gate holds is not stopped by the clock",
			).toContain("topic published to origin");
		},
		REAL_GIT_MS,
	);
});
