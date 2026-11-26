/**
 * A session resumed in a new process owns its trees' records again.
 *
 * A record names its holders by process, and a session outlives its
 * process: after a host restart each conversation resumes under the new
 * host's pid while its records still name the old one. The disk guard
 * judges a tree by those owners, so on 17 November it took the
 * node_modules of a tree SS241B's session was running its gate in four
 * times after an 11:06 restart (1DZYLJ). Starting the session again
 * names the process it runs in now.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import workIntegration from "../../../extensions/work-integration/index.ts";
import { installHost, withSession } from "../../../lib/core/session/index.ts";
import { createTreeMemory } from "../../../lib/core/work/memory.ts";
import { treeRecordDir } from "../../../lib/internal/work-records.ts";
import { sessionHost } from "../../support/session-host.ts";
import { activateWith } from "../support/review-extension.ts";

/** A pid no process holds, as the host that cut the tree had. */
const GONE = 999_999_999;

/** When the host that resumed the session started. */
const RESTARTED = 5_000;

let root: string;
let removeHost: () => void;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "resumed-session-"));
	vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
	const { host } = sessionHost({ pid: process.pid, startedAt: RESTARTED });
	removeHost = installHost(host);
});
afterEach(() => {
	removeHost();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

/** A tree on disk whose record names `session`, held by the host before. */
function cutBeforeTheRestart(session: string, key: string): string {
	const path = join(root, "trees", key);
	mkdirSync(path, { recursive: true });
	createTreeMemory(treeRecordDir()).remember({
		identity: { key, shareable: false },
		path,
		providerId: "git-worktree",
		owners: [{ pid: GONE, startedAt: 1_000, session, host: "test-host" }],
		sessions: [session],
	});
	return path;
}

/** The owners the record of the tree at `path` names now. */
function ownersOf(path: string) {
	const tree = createTreeMemory(treeRecordDir())
		.recall()
		.find((one) => one.path === path);
	return tree?.owners;
}

it("names the new host's process on a resumed session's trees, leaving others' alone", async () => {
	const ours = cutBeforeTheRestart("a", "ours");
	const theirs = cutBeforeTheRestart("b", "theirs");
	const stub = activateWith(workIntegration);
	const started = stub.lifecycle.get("session_start");
	if (started === undefined)
		throw new Error("work-integration registered no session_start");

	withSession("a", () =>
		started(
			{ reason: "resume" },
			{ sessionManager: { getSessionId: () => "a" } },
		),
	);

	await vi.waitFor(
		() =>
			expect(
				ownersOf(ours),
				"the resumed session's record names the process it runs in now",
			).toEqual([
				{
					pid: process.pid,
					startedAt: RESTARTED,
					session: "a",
					host: "test-host",
				},
			]),
		// Under vitest's own 5 s limit, so a red says why rather than that
		// the test timed out.
		{ timeout: 3_000 },
	);
	expect(ownersOf(theirs), "another session's record is its own").toEqual([
		{ pid: GONE, startedAt: 1_000, session: "b", host: "test-host" },
	]);
});

it("says on stderr when a resumed session's trees could not be re-owned", async () => {
	const ours = cutBeforeTheRestart("a", "ours");
	const said = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	// A folder nobody may list fails the reading, as a fault the start
	// can't settle would.
	chmodSync(treeRecordDir(), 0o000);
	try {
		const stub = activateWith(workIntegration);
		const started = stub.lifecycle.get("session_start");
		if (started === undefined)
			throw new Error("work-integration registered no session_start");

		withSession("a", () =>
			started(
				{ reason: "resume" },
				{ sessionManager: { getSessionId: () => "a" } },
			),
		);

		await vi.waitFor(
			() =>
				expect(
					said.mock.calls.map(([line]) => String(line)).join(""),
					"the failed re-owning was said",
				).toMatch(
					/the trees session a holds still name the process it ran in before.*EACCES/,
				),
			{ timeout: 3_000 },
		);
	} finally {
		chmodSync(treeRecordDir(), 0o755);
		said.mockRestore();
	}
	expect(ownersOf(ours), "the record keeps its old owner").toEqual([
		{ pid: GONE, startedAt: 1_000, session: "a", host: "test-host" },
	]);
});
