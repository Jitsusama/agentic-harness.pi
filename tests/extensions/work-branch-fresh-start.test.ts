/**
 * A branch asked to start from a remote's branch starts from where that
 * branch is now, not where the last fetch left it.
 *
 * Run against real repositories: a bare origin, a clone that falls behind
 * it, and a second clone that pushes past it, since what is being checked
 * is what git's tracking ref says after the fetch.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnExec } from "@jitsusama/agentic-harness.core/exec";
import {
	type TreeClaims,
	WORK_TREE_CLAIMS,
} from "@jitsusama/agentic-harness.core/work";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetTreeBroker } from "../../extensions/work-integration/broker.ts";
import {
	refreshStart,
	remoteBranchOf,
} from "../../extensions/work-integration/fresh-start.ts";
import workIntegration from "../../extensions/work-integration/index.ts";
import { disposeRepo, freshRepo, git } from "../support/git-fixture.ts";
import {
	activateWith,
	HEADLESS,
	toolNamed,
} from "./support/review-extension.ts";

let seed: string;
let place: string;
let origin: string;
let behind: string;
let ahead: string;
let savedState: string | undefined;

beforeEach(async () => {
	savedState = process.env.XDG_STATE_HOME;
	forgetTreeBroker();
	seed = await freshRepo("fresh-start-seed");
	place = realpathSync(mkdtempSync(join(tmpdir(), "fresh-start-")));
	origin = join(place, "origin.git");
	behind = join(place, "behind");
	ahead = join(place, "ahead");
	await git(place, "clone", "-q", "--bare", seed, origin);
	await git(place, "clone", "-q", origin, behind);
	await git(place, "clone", "-q", origin, ahead);
	process.env.XDG_STATE_HOME = join(place, "state");
	for (const dir of [behind, ahead]) {
		await git(dir, "config", "user.email", "test@example.com");
		await git(dir, "config", "user.name", "Test");
		await git(dir, "config", "commit.gpgsign", "false");
	}
});

afterEach(() => {
	forgetTreeBroker();
	if (savedState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedState;
	disposeRepo(seed);
	rmSync(place, { recursive: true, force: true });
});

/** Push a commit to origin's main from the other clone; its hash. */
async function moveOriginOn(): Promise<string> {
	writeFileSync(join(ahead, "later.md"), "later\n");
	await git(ahead, "add", "later.md");
	await git(ahead, "commit", "-qm", "later");
	await git(ahead, "push", "-q", "origin", "main");
	return git(ahead, "rev-parse", "HEAD");
}

describe("the remote branch a start point names", () => {
	it("is read from the remote's name and the rest", () => {
		expect(remoteBranchOf("origin/main", ["origin"])).toEqual({
			remote: "origin",
			branch: "main",
		});
		expect(remoteBranchOf("origin/jg/topic", ["origin"])).toEqual({
			remote: "origin",
			branch: "jg/topic",
		});
	});

	it("takes the longest remote a name could belong to", () => {
		expect(
			remoteBranchOf("origin/mirror/main", ["origin", "origin/mirror"]),
		).toEqual({ remote: "origin/mirror", branch: "main" });
	});

	it("is nothing for a local branch or a commit", () => {
		expect(remoteBranchOf("main", ["origin"])).toBeUndefined();
		expect(remoteBranchOf("0f34b0ba", ["origin"])).toBeUndefined();
		expect(remoteBranchOf("origin/", ["origin"])).toBeUndefined();
	});
});

describe("refreshing a start point before branching", () => {
	it("brings a remote's branch up to where the remote has it now", async () => {
		const now = await moveOriginOn();
		expect(await git(behind, "rev-parse", "origin/main")).not.toBe(now);

		const said = await refreshStart(spawnExec(), behind, "origin/main");

		expect(said).toBeUndefined();
		expect(await git(behind, "rev-parse", "origin/main")).toBe(now);
	});

	it("brings it up even where the checkout's configured fetch leaves that branch out", async () => {
		// A monorepo checkout is often set to fetch only a few branches.
		await git(
			behind,
			"config",
			"remote.origin.fetch",
			"+refs/heads/elsewhere:refs/remotes/origin/elsewhere",
		);
		const now = await moveOriginOn();

		await refreshStart(spawnExec(), behind, "origin/main");

		expect(await git(behind, "rev-parse", "origin/main")).toBe(now);
	});

	it("is what work branch does, naming the commit the branch starts at", async () => {
		const now = await moveOriginOn();
		const stub = activateWith(workIntegration);
		stub.pi.events.on(WORK_TREE_CLAIMS, (data) => {
			(data as TreeClaims).paths.push(behind);
		});
		const work = toolNamed(stub, "work");

		const answer = (await work.execute(
			"call",
			{
				action: "branch",
				tree: behind,
				name: "jg/topic",
				from: "origin/main",
			},
			undefined,
			undefined,
			HEADLESS,
		)) as { content: { text: string }[] };

		expect(await git(behind, "rev-parse", "jg/topic")).toBe(now);
		expect(answer.content[0]?.text).toContain(
			`is on jg/topic, at ${now.slice(0, 12)} from origin/main.`,
		);
	});

	it("fetches nothing for a local start point", async () => {
		const now = await moveOriginOn();
		const before = await git(behind, "rev-parse", "origin/main");

		const said = await refreshStart(spawnExec(), behind, "main");

		expect(said).toBeUndefined();
		expect(await git(behind, "rev-parse", "origin/main")).toBe(before);
		expect(before).not.toBe(now);
	});

	it("says so when the remote cannot be reached, and leaves the start point as it was", async () => {
		const before = await git(behind, "rev-parse", "origin/main");
		await git(behind, "remote", "set-url", "origin", join(place, "gone.git"));

		const said = await refreshStart(spawnExec(), behind, "origin/main");

		expect(said).toMatch(
			/^Could not fetch origin\/main just now \(.+\), so it starts where origin\/main stood at the last fetch\.$/,
		);
		expect(await git(behind, "rev-parse", "origin/main")).toBe(before);
	});
});
