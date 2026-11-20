/**
 * The work tool driven as a session drives it, over trees a test
 * provider cuts.
 *
 * The provider cuts each tree as a copy of one fresh repository, in a
 * scratch folder rather than where the git provider cuts them: git
 * won't read a worktree there whose repository the fence doesn't
 * guard, which no temporary repository is. Registers its own setup and
 * cleanup: the broker's memory in the scratch folder, a forgotten
 * broker, and the provider.
 */

import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { forgetTreeBroker } from "../../../extensions/work-integration/broker.ts";
import workIntegration from "../../../extensions/work-integration/index.ts";
import {
	registerTreeProvider,
	type TreeClaims,
	type TreeProvider,
	unregisterTreeProvider,
	WORK_TREE_CLAIMS,
} from "../../../lib/core/work/index.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";
import {
	activateWith,
	HEADLESS,
	type RegisteredTool,
	toolNamed,
} from "../support/review-extension.ts";

/** The repository key the test provider serves. */
export const REPO = "test:worked/repo";

/** What one call of the tool answered: its text, and its details. */
export interface Worked {
	text: string;
	details: Record<string, unknown>;
}

let scratch = "";
let repo = "";
let savedState: string | undefined;
let tool: RegisteredTool | undefined;
let said: { event: string; data: unknown }[] = [];
let claimed: string[] = [];

/** Cuts each tree as a copy of the test's repository, at what was asked. */
const COPYING: TreeProvider = {
	id: "copying",
	specificity: 1_000,
	appliesTo: (asked) => asked.key === REPO,
	ensure: async (request) => {
		const path = join(scratch, "trees", request.purpose);
		cpSync(repo, path, { recursive: true });
		if (request.intent === "snapshot") {
			await git(path, "checkout", "-q", "--detach", request.commit);
		} else {
			await git(path, "checkout", "-q", "-b", request.branch);
		}
		return { path };
	},
	release: async (held) => {
		rmSync(held.path, { recursive: true, force: true });
	},
};

beforeEach(async () => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "worked-")));
	savedState = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = join(scratch, "state");
	forgetTreeBroker();
	repo = await freshRepo("worked");
	const stub = activateWith(workIntegration);
	claimed = [];
	stub.pi.events.on(WORK_TREE_CLAIMS, (data) => {
		(data as TreeClaims).paths.push(...claimed);
	});
	said = stub.emitted;
	tool = toolNamed(stub, "work");
	registerTreeProvider(COPYING);
});

afterEach(() => {
	unregisterTreeProvider(COPYING.id);
	forgetTreeBroker();
	if (savedState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedState;
	disposeRepo(repo);
	rmSync(scratch, { recursive: true, force: true });
});

/** The repository trees are cut from, on `main` with one commit. */
export function checkout(): string {
	return repo;
}

/** What the tool said on pi's bus, in order. */
export function emitted(): readonly { event: string; data: unknown }[] {
	return said;
}

/** Have a quest claim the tree at `path`, as one holding it would. */
export function claim(path: string): void {
	claimed.push(path);
}

/** A folder of this test's own, removed after it. */
export function scratchDir(): string {
	return scratch;
}

/** Call the work tool once, headless. */
export async function work(args: Record<string, unknown>): Promise<Worked> {
	if (tool === undefined) throw new Error("work called outside a test");
	const answer = (await tool.execute(
		"call",
		args,
		undefined,
		undefined,
		HEADLESS,
	)) as { content: { text: string }[]; details?: Record<string, unknown> };
	return { text: answer.content[0]?.text ?? "", details: answer.details ?? {} };
}

/** Cut a tree at a new branch, returning its key and path. */
export async function cut(
	branch = "topic",
): Promise<{ key: string; path: string }> {
	const { details } = await work({
		action: "tree",
		repo: REPO,
		purpose: branch,
		branch,
	});
	const { key, path } = details;
	if (typeof key !== "string" || typeof path !== "string") {
		throw new Error(`the cut answered no tree: ${JSON.stringify(details)}`);
	}
	return { key, path };
}
