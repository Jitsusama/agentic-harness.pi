/**
 * The work tool on a tree a quest holds.
 *
 * A quest cuts trees the work tool's broker never saw, and naming one
 * answered "No held tree called ...", so commits and pushes in quest
 * trees fell back to raw git. The tool now finds such a tree by asking
 * who claims it, and leaves releasing it to the quest.
 */

import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetTreeBroker } from "../../../extensions/work-integration/broker.ts";
import workIntegration from "../../../extensions/work-integration/index.ts";
import {
	type TreeClaims,
	WORK_TREE_CLAIMS,
} from "../../../lib/core/work/index.ts";
import { disposeRepo, freshRepo } from "../../support/git-fixture.ts";
import {
	activateWith,
	HEADLESS,
	toolNamed,
} from "../support/review-extension.ts";

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
		expect(released.content[0]?.text).toContain("quest tree-release");
		expect(released.details?.ok).not.toBe(true);
	});

	it("is found when only its holder's fresh answer names it", async () => {
		repo = await freshRepo("work-claimed-late");
		const tree = realpathSync(repo);
		const stub = activateWith(workIntegration);
		// A holder whose last read predates the tree, as a host's can.
		stub.pi.events.on(WORK_TREE_CLAIMS, (data) => {
			const claims = data as TreeClaims;
			claims.answering?.push(
				Promise.resolve().then(() => {
					claims.paths.push(tree);
				}),
			);
		});
		const work = toolNamed(stub, "work");
		const status = (await work.execute(
			"call",
			{ action: "status", tree },
			undefined,
			undefined,
			HEADLESS,
		)) as { content: { text: string }[] };
		expect(status.content[0]?.text).toContain(`${tree} is clean`);
	});

	it("is not invented for a path nobody claims", async () => {
		const { run } = await workWithClaim();
		const status = await run({ action: "status", tree: join(root, "other") });
		expect(status.content[0]?.text).toContain("No held tree called");
	});

	it("asks no holder for a fresh answer when the quick one holds it", async () => {
		const { tree, run } = await workWithClaimAndAsks();
		await run({ action: "status", tree });
		expect(asks.fresh, "fresh answers asked for").toBe(0);
	});

	it("asks no holder for a fresh answer for a path that isn't there", async () => {
		const { run } = await workWithClaimAndAsks();
		const status = await run({ action: "status", tree: join(root, "gone") });
		expect(status.content[0]?.text).toContain("No held tree called");
		expect(asks.fresh, "fresh answers asked for").toBe(0);
	});

	it("stops waiting on a fresh answer when the call is stopped", async () => {
		const stub = activateWith(workIntegration);
		// A holder whose fresh answer never comes, as a hung disk's.
		stub.pi.events.on(WORK_TREE_CLAIMS, (data) => {
			(data as TreeClaims).answering?.push(new Promise(() => undefined));
		});
		const work = toolNamed(stub, "work");
		const stop = new AbortController();
		const asked = work.execute(
			"call",
			{ action: "status", tree: root },
			stop.signal,
			undefined,
			HEADLESS,
		);
		stop.abort();
		// Ended either way, rather than waiting on the holder for good.
		const ended = () => "ended";
		expect(await asked.then(ended, ended)).toBe("ended");
	});
});

/** How many fresh answers a holder was asked for. */
const asks = { fresh: 0 };

/** The work tool with a claim, counting the asks that offer to wait. */
async function workWithClaimAndAsks() {
	asks.fresh = 0;
	const claimed = await workWithClaim();
	const stub = activateWith(workIntegration);
	stub.pi.events.on(WORK_TREE_CLAIMS, (data) => {
		const claims = data as TreeClaims;
		claims.paths.push(claimed.tree);
		if (claims.answering) asks.fresh += 1;
	});
	const work = toolNamed(stub, "work");
	const run = (args: Record<string, unknown>) =>
		work.execute("call", args, undefined, undefined, HEADLESS) as Promise<{
			content: { text: string }[];
		}>;
	return { tree: claimed.tree, run };
}

/**
 * The work tool, with a quest claiming a tree whose checkout sits in a
 * folder below it, the way `quest tree-add` cuts a World tree: the claim
 * is the tree, and git's checkout is its `src/`.
 */
async function workWithNestedClaim() {
	repo = await freshRepo("work-claimed-nested");
	const tree = join(root, "world-tree");
	const checkout = join(tree, "src");
	cpSync(repo, checkout, { recursive: true });
	mkdirSync(join(checkout, "areas"), { recursive: true });
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
	return { tree: realpathSync(tree), checkout: realpathSync(checkout), run };
}

describe("a tree a quest holds with its checkout in a folder below", () => {
	it("runs git in the checkout when named by the tree", async () => {
		const { tree, run } = await workWithNestedClaim();
		const status = await run({ action: "status", tree });
		expect(status.content[0]?.text).toContain(`${tree} is clean, on main`);
	});

	it("runs git in the checkout when named by a path inside it", async () => {
		const { tree, checkout, run } = await workWithNestedClaim();
		const status = await run({
			action: "status",
			tree: join(checkout, "areas"),
		});
		expect(status.content[0]?.text).toContain(`${tree} is clean, on main`);
	});

	it("makes a branch there", async () => {
		const { tree, run } = await workWithNestedClaim();
		const made = await run({ action: "branch", tree, name: "nested-work" });
		expect(made.content[0]?.text).not.toContain("not a git repository");
		expect(made.details?.ok).not.toBe(false);
	});
});
