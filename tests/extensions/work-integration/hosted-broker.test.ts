/** Two conversations in one host each name only themselves on the trees they cut. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	forgetTreeBroker,
	treeBroker,
	treesHeldBySession,
} from "../../../extensions/work-integration/broker.ts";
import { installHost, withSession } from "../../../lib/core/session/index.ts";
import {
	registerTreeProvider,
	type TreeProvider,
	unregisterTreeProvider,
} from "../../../lib/core/work/index.ts";
import { recordedTrees } from "../../../lib/internal/work-records.ts";
import { sessionHost } from "../../support/session-host.ts";

const REPO = "test:elsewhere/hosted";

let root: string;
let removeHost: () => void;

/** A provider cutting a real, empty git checkout per purpose. */
const CUTTING: TreeProvider = {
	id: "hosted-cutting",
	specificity: 1_000,
	appliesTo: (repo) => repo.key === REPO,
	ensure: async (request) => {
		const path = join(root, "cut", request.purpose);
		mkdirSync(path, { recursive: true });
		execFileSync("git", ["init", "-q", path]);
		return { path };
	},
	release: async () => {},
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hosted-broker-"));
	vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
	const { host } = sessionHost({ pid: process.pid, startedAt: Date.now() });
	removeHost = installHost(host);
	registerTreeProvider(CUTTING);
});
afterEach(() => {
	unregisterTreeProvider(CUTTING.id);
	removeHost();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

it("records A's tree under A even after B started last", async () => {
	await withSession("a", () => treesHeldBySession("a", undefined));
	await withSession("b", () => treesHeldBySession("b", undefined));

	const cut = (purpose: string) =>
		treeBroker().ensure({
			intent: "worktree",
			repo: { key: REPO },
			purpose,
			branch: purpose,
		});
	await withSession("a", () => cut("of-a"));
	await withSession("b", () => cut("of-b"));

	const byPath = new Map(
		recordedTrees().map((tree) => [tree.path, tree.sessions]),
	);
	expect(byPath.get(join(root, "cut", "of-a"))).toEqual(["a"]);
	expect(byPath.get(join(root, "cut", "of-b"))).toEqual(["b"]);
});

it("keeps B's broker when A starts again", async () => {
	const b = withSession("b", () => treeBroker());
	const a = withSession("a", () => treeBroker());
	expect(a, "each conversation has its own broker").not.toBe(b);

	forgetTreeBroker("a");
	expect(
		withSession("b", () => treeBroker()),
		"forgetting A's broker leaves B's cached",
	).toBe(b);
	expect(withSession("a", () => treeBroker())).not.toBe(a);
});
