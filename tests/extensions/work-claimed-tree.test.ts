/**
 * The work tool on a tree a quest holds.
 *
 * A quest cuts trees the work tool's broker never saw, and naming one
 * answered "No held tree called ...", so commits and pushes in quest
 * trees fell back to raw git. The tool now finds such a tree by asking
 * who claims it, and leaves releasing it to the quest.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type TreeClaims,
	WORK_TREE_CLAIMS,
} from "@jitsusama/agentic-harness.core/work";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetTreeBroker } from "../../extensions/work-integration/broker.ts";
import workIntegration from "../../extensions/work-integration/index.ts";
import { disposeRepo, freshRepo } from "../support/git-fixture.ts";
import {
	activateWith,
	HEADLESS,
	toolNamed,
} from "./support/review-extension.ts";

let root: string;
let savedState: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "work-claimed-"));
	savedState = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = join(root, "state");
	forgetTreeBroker();
});
afterEach(() => {
	forgetTreeBroker();
	if (savedState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedState;
	rmSync(root, { recursive: true, force: true });
});

let repo: string | undefined;
afterEach(() => {
	disposeRepo(repo);
	repo = undefined;
});

/** The work tool, with a quest claiming one real git tree. */
async function workWithClaim() {
	repo = await freshRepo("work-claimed");
	const tree = realpathSync(repo);
	mkdirSync(join(tree, "src"), { recursive: true });
	const stub = activateWith(workIntegration);
	stub.pi.events.on(WORK_TREE_CLAIMS, (data) => {
		(data as TreeClaims).paths.push(tree);
	});
	const work = toolNamed(stub, "work");
	const run = (args: Record<string, unknown>) =>
		work.execute("call", args, undefined, undefined, HEADLESS) as Promise<{
			content: { text: string }[];
			details?: { ok?: boolean };
		}>;
	return { tree, run };
}

describe("a tree a quest holds", () => {
	it("is found by a path inside it", async () => {
		const { tree, run } = await workWithClaim();
		const status = await run({ action: "status", tree: join(tree, "src") });
		expect(status.content[0]?.text).toContain(`${tree} is clean`);
	});

	it("is not released from here, and says how it is", async () => {
		const { tree, run } = await workWithClaim();
		const released = await run({ action: "release", tree });
		expect(released.content[0]?.text).toContain("quest tree-prune");
		expect(released.details?.ok).not.toBe(true);
	});

	it("is not invented for a path nobody claims", async () => {
		const { run } = await workWithClaim();
		const status = await run({ action: "status", tree: join(root, "other") });
		expect(status.content[0]?.text).toContain("No held tree called");
	});
});
