/**
 * A tree the work tool cuts comes with its repo's rules.
 *
 * pi loads AGENTS.md only from the folder a session starts in and its
 * parents, so a session started in home that cuts a tree in core.nix
 * never read core's rules: on 2026-11-03 seventeen sessions worked that
 * way. The answer that hands over the tree says them instead.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetTreeBroker } from "../../extensions/work-integration/broker.ts";
import workIntegration from "../../extensions/work-integration/index.ts";
import {
	registerTreeProvider,
	type TreeProvider,
	unregisterTreeProvider,
} from "../../lib/core/work/index.ts";
import { activateWith, toolNamed } from "./support/review-extension.ts";

const REPO = "test:elsewhere/ruled";

let root: string;
let savedState: string | undefined;

/** A provider serving one made-up repo whose checkout carries rules. */
const RULED: TreeProvider = {
	id: "ruled-work",
	specificity: 1_000,
	appliesTo: (repo) => repo.key === REPO,
	ensure: async (request) => {
		const path = join(root, request.purpose);
		mkdirSync(path, { recursive: true });
		execFileSync("git", ["init", "-q", path]);
		writeFileSync(join(path, "AGENTS.md"), "Run the test pyramid.\n");
		return { path };
	},
	release: async () => {},
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "work-tree-rules-"));
	savedState = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = join(root, "state");
	forgetTreeBroker();
});
afterEach(() => {
	unregisterTreeProvider(RULED.id);
	forgetTreeBroker();
	if (savedState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedState;
	rmSync(root, { recursive: true, force: true });
});

describe("a tree cut in a repo the session did not start in", () => {
	it("is handed over with the repo's rules", async () => {
		const stub = activateWith(workIntegration);
		registerTreeProvider(RULED);
		const work = toolNamed(stub, "work");
		const started = join(root, "home");
		mkdirSync(started);
		const session = `work-rules-${process.pid}-${Date.now()}`;
		const cut = (await work.execute(
			"call-1",
			{ action: "tree", repo: REPO, purpose: "ruled", branch: "main" },
			undefined,
			undefined,
			{
				hasUI: false,
				cwd: started,
				sessionManager: { getSessionId: () => session },
			},
		)) as { content: { text: string }[] };
		const text = cut.content[0]?.text ?? "";
		expect(text).toContain(join(root, "ruled", "AGENTS.md"));
		expect(text).toContain("Run the test pyramid.");
	});

	it("comes without them where the conversation already read them, wherever its process stands", async () => {
		const stub = activateWith(workIntegration);
		registerTreeProvider(RULED);
		const work = toolNamed(stub, "work");
		const started = join(root, "ruled-home");
		mkdirSync(started);
		writeFileSync(join(started, "AGENTS.md"), "Run the test pyramid.\n");
		const session = `work-rules-read-${process.pid}-${Date.now()}`;
		const cut = (await work.execute(
			"call-1",
			{ action: "tree", repo: REPO, purpose: "ruled", branch: "main" },
			undefined,
			undefined,
			{
				hasUI: false,
				cwd: started,
				sessionManager: { getSessionId: () => session },
			},
		)) as { content: { text: string }[] };
		expect(
			cut.content[0]?.text ?? "",
			"the rules the conversation's folder gave it at start",
		).not.toContain("Run the test pyramid.");
	});
});
