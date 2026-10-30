/**
 * The work tool carrying a tree home, as a session on a leaving machine
 * asks it to.
 *
 * The library's bundling is tested on its own; what is left here is where
 * the tool puts things, since the share carries only the quest's
 * `handover/` scratch folder, and a handover written anywhere else stays
 * on a machine about to be destroyed.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetTreeBroker } from "../../extensions/work-integration/broker.ts";
import workIntegration from "../../extensions/work-integration/index.ts";
import {
	type TreeClaims,
	WORK_TREE_CLAIMS,
} from "../../lib/core/work/index.ts";
import { sessionRegistryDir } from "../../lib/internal/quest/loaded.ts";
import { questWorkspacesRoot } from "../../lib/internal/quest/workspace-root.ts";
import { disposeRepo, freshRepo, git } from "../support/git-fixture.ts";
import { activateWith, toolNamed } from "./support/review-extension.ts";

const QUEST = "QEST-20261030-ABCDEF";
const SESSION = "0a1b2c3d";

let root: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "work-carry-"));
	for (const name of ["XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
		saved[name] = process.env[name];
	}
	process.env.XDG_STATE_HOME = join(root, "state");
	process.env.XDG_CACHE_HOME = join(root, "cache");
	forgetTreeBroker();
});
afterEach(() => {
	forgetTreeBroker();
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

let repo: string | undefined;
afterEach(() => {
	disposeRepo(repo);
	repo = undefined;
});

/** Says, as the quest workflow does, that this session has `quest` loaded. */
function loaded(quest: string): void {
	const sessions = sessionRegistryDir();
	mkdirSync(sessions, { recursive: true });
	writeFileSync(
		join(sessions, `${SESSION}.json`),
		JSON.stringify({
			sessionId: SESSION,
			instanceId: "instance",
			cwd: root,
			openedAt: "2026-10-30T18:00:00Z",
			quest,
		}),
	);
}

/** The work tool, on a tree with one commit no remote has. */
async function workOnUnpushedTree() {
	repo = await freshRepo("work-carry");
	const tree = realpathSync(repo);
	await git(tree, "checkout", "-q", "-b", "topic");
	await git(tree, "commit", "-q", "--allow-empty", "-m", "unpushed");
	const file = join(root, "session.jsonl");
	writeFileSync(file, '{"type":"session"}\n');
	const stub = activateWith(workIntegration);
	stub.pi.events.on(WORK_TREE_CLAIMS, (data) => {
		(data as TreeClaims).paths.push(tree);
	});
	const work = toolNamed(stub, "work");
	const ctx = {
		hasUI: false,
		sessionManager: {
			getSessionId: () => SESSION,
			getSessionFile: () => file,
			getCwd: () => tree,
			getSessionName: () => undefined,
		},
	};
	const run = (args: Record<string, unknown>) =>
		work.execute("call", args, undefined, undefined, ctx) as Promise<{
			content: { text: string }[];
			details?: { ok?: boolean };
		}>;
	return { tree, run };
}

describe("carrying a tree home", () => {
	it("writes the bundle and this session into the quest's handover folder", async () => {
		loaded(QUEST);
		const { tree, run } = await workOnUnpushedTree();

		const carried = await run({ action: "carry", tree });

		expect(carried.details?.ok, carried.content[0]?.text).toBe(true);
		const into = join(questWorkspacesRoot(), QUEST, "handover", hostname());
		expect(
			readdirNames(into).some((name) => name.endsWith(".bundle")),
			"the tree's bundle is in this machine's handover",
		).toBe(true);
		expect(
			JSON.parse(
				readFileSync(join(into, "sessions", `${SESSION}.json`), "utf8"),
			),
			"beside this session, as Restore needs it",
		).toEqual({
			id: SESSION,
			cwd: tree,
			quest: QUEST,
			file: "session.jsonl",
		});
	});

	it("is refused with no quest loaded, having nowhere to go home", async () => {
		const { tree, run } = await workOnUnpushedTree();

		const carried = await run({ action: "carry", tree });

		expect(carried.details?.ok, "nothing is carried").not.toBe(true);
		expect(carried.content[0]?.text).toContain("No quest is loaded");
		expect(existsSync(questWorkspacesRoot()), "and nothing is written").toBe(
			false,
		);
	});
});

/** The names in a folder, or none when it isn't there. */
function readdirNames(folder: string): string[] {
	return existsSync(folder) ? readdirSync(folder) : [];
}
