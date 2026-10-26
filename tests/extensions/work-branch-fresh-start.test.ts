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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetTreeBroker } from "../../extensions/work-integration/broker.ts";
import {
	refreshStart,
	remoteBranchOf,
} from "../../extensions/work-integration/fresh-start.ts";
import workIntegration from "../../extensions/work-integration/index.ts";
import { spawnExec } from "../../lib/core/exec/index.ts";
import {
	type TreeClaims,
	WORK_TREE_CLAIMS,
} from "../../lib/core/work/index.ts";
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

	it("reads the full spellings of a remote's branch the same way", () => {
		const main = { remote: "origin", branch: "main" };
		expect(remoteBranchOf("refs/remotes/origin/main", ["origin"])).toEqual(
			main,
		);
		expect(remoteBranchOf("remotes/origin/main", ["origin"])).toEqual(main);
		expect(remoteBranchOf(" origin/main ", ["origin"])).toEqual(main);
	});

	it("is nothing for a local branch or a commit", () => {
		expect(remoteBranchOf("main", ["origin"])).toBeUndefined();
		expect(remoteBranchOf("0f34b0ba", ["origin"])).toBeUndefined();
		expect(remoteBranchOf("origin/", ["origin"])).toBeUndefined();
	});

	it("is nothing for a start point the branch call will refuse, so it costs no fetch", () => {
		// `origin/*` would otherwise have become a forced fetch of every branch.
		expect(remoteBranchOf("origin/*", ["origin"])).toBeUndefined();
		expect(remoteBranchOf("origin/main~1", ["origin"])).toBeUndefined();
		expect(remoteBranchOf("origin/a:b", ["origin"])).toBeUndefined();
	});
});

/** The work tool, holding the behind clone as a quest's tree. */
function workTool() {
	const stub = activateWith(workIntegration);
	stub.pi.events.on(WORK_TREE_CLAIMS, (data) => {
		(data as TreeClaims).paths.push(behind);
	});
	const work = toolNamed(stub, "work");
	return (args: Record<string, unknown>) =>
		work.execute("call", args, undefined, undefined, HEADLESS) as Promise<{
			content: { text: string }[];
			details?: { ok?: boolean; fresh?: boolean };
		}>;
}

describe("refreshing a start point before branching", () => {
	it("brings a remote's branch up to where the remote has it now", async () => {
		const now = await moveOriginOn();
		expect(await git(behind, "rev-parse", "origin/main")).not.toBe(now);

		const said = await refreshStart(spawnExec(), behind, "origin/main");

		expect(said).toEqual({ start: "refs/remotes/origin/main" });
		expect(await git(behind, "rev-parse", "origin/main")).toBe(now);
	});

	it("does not fetch the remote's default pointer, and says to name the branch", async () => {
		await git(behind, "remote", "set-head", "origin", "main");

		const said = await refreshStart(spawnExec(), behind, "origin/HEAD");

		expect(said.start).toBe("refs/remotes/origin/HEAD");
		expect(said.stale).toMatch(/name the branch itself/);
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

		const answer = await workTool()({
			action: "branch",
			tree: behind,
			name: "jg/topic",
			from: "origin/main",
		});

		expect(await git(behind, "rev-parse", "jg/topic")).toBe(now);
		expect(answer.content[0]?.text).toContain(
			`is on jg/topic, at ${now.slice(0, 12)} from origin/main.`,
		);
		expect(answer.details?.fresh).toBe(true);
		expect(
			await git(behind, "rev-parse", "--abbrev-ref", "jg/topic@{upstream}"),
		).toBe("origin/main");
	});

	it("starts from the remote's branch even when a local branch shares its short name", async () => {
		// A local branch called origin/main makes the short name ambiguous.
		await git(behind, "branch", "origin/main", "HEAD");
		const now = await moveOriginOn();

		await workTool()({
			action: "branch",
			tree: behind,
			name: "jg/topic",
			from: "origin/main",
		});

		expect(await git(behind, "rev-parse", "jg/topic")).toBe(now);
	});

	it("still makes the branch when the fetch fails, and says it is from the last fetch", async () => {
		const before = await git(behind, "rev-parse", "origin/main");
		await git(behind, "remote", "set-url", "origin", join(place, "gone.git"));

		const answer = await workTool()({
			action: "branch",
			tree: behind,
			name: "jg/topic",
			from: "origin/main",
		});

		expect(await git(behind, "rev-parse", "jg/topic")).toBe(before);
		expect(answer.content[0]?.text).toMatch(/Could not fetch origin\/main/);
		expect(answer.details?.fresh).toBe(false);
	});

	it("keeps the fetch's reason when there was no earlier fetch to fall back on", async () => {
		await git(behind, "remote", "set-url", "origin", join(place, "gone.git"));

		const answer = await workTool()({
			action: "branch",
			tree: behind,
			name: "jg/topic",
			from: "origin/never-fetched",
		});

		expect(answer.details?.ok).not.toBe(true);
		expect(answer.content[0]?.text).toMatch(
			/Could not fetch origin\/never-fetched/,
		);
	});

	it("fetches nothing for a local start point", async () => {
		const now = await moveOriginOn();
		const before = await git(behind, "rev-parse", "origin/main");

		const said = await refreshStart(spawnExec(), behind, "main");

		expect(said).toEqual({ start: "main" });
		expect(await git(behind, "rev-parse", "origin/main")).toBe(before);
		expect(before).not.toBe(now);
	});

	it("says so when the remote cannot be reached, and leaves the start point as it was", async () => {
		const before = await git(behind, "rev-parse", "origin/main");
		await git(behind, "remote", "set-url", "origin", join(place, "gone.git"));

		const said = await refreshStart(spawnExec(), behind, "origin/main");

		expect(said.stale).toMatch(
			/^Could not fetch origin\/main just now \(.+\), so it starts where origin\/main stood at the last fetch\.$/,
		);
		expect(await git(behind, "rev-parse", "origin/main")).toBe(before);
	});
});
