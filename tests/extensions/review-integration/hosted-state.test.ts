/**
 * Two conversations a host holds in one folder keep their review state
 * apart.
 *
 * pi caches an extension's module by path while the folder stays the
 * same, so a host opening two conversations there runs one copy of the
 * review integration for both. State kept in that module's variables was
 * the last conversation's: its start forgot the other's working layer and
 * attachments name, and unsubscribed the other's listener, which then
 * kept the last conversation's whole session alive after it parked.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionKey } from "../../../extensions/review-integration/engine.ts";
import { treeStandingFor } from "../../../extensions/review-integration/work.ts";
import {
	type Host,
	installHost,
	releaseSession,
	withSession,
} from "../../../lib/core/session/index.ts";
import {
	type HeldTree,
	treeIdentity,
	WORK_READY,
} from "../../../lib/core/work/index.ts";
import { activate } from "../support/review-extension.ts";

const REPO = { key: "github:acme/widgets", localPath: "/src/widgets" };
const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";

let root: string;
let removeHost: () => void;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "review-hosted-state-"));
	vi.stubEnv("XDG_STATE_HOME", root);
	const host: Host = {
		kind: "pi-durable",
		key: "review-hosted-state",
		owner: { pid: process.pid, startedAt: 1000 },
		holds: () => "idle",
		env: () => {
			throw new Error("review state needs no environment");
		},
		hints: () => ({}),
		close: (id) => releaseSession(id),
		stamp: () => {},
	};
	removeHost = installHost(host);
});

afterEach(() => {
	for (const id of ["a", "b"]) releaseSession(id);
	removeHost();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

/** A working layer holding one snapshot of the change, at this path. */
function layerHolding(path: string) {
	const tree: HeldTree = {
		identity: treeIdentity({
			intent: "snapshot",
			repo: REPO,
			purpose: "review",
			commit: COMMIT,
		}),
		path,
		providerId: "git-worktree",
	};
	return {
		registerTreeProvider() {},
		listTreeProviders: () => [],
		broker: () => ({
			held: () => [tree],
			ensure() {
				throw new Error("standing cuts nothing");
			},
			release() {},
			cutHere: () => false,
		}),
	};
}

/** One conversation: the extension loaded, started and given its layer. */
async function conversation(id: string) {
	const stub = withSession(id, () => activate());
	const started = stub.lifecycle.get("session_start");
	if (!started) throw new Error("the extension registered no session_start");
	await withSession(id, () =>
		started(
			{ reason: "startup" },
			{ hasUI: false, cwd: root, sessionManager: { getSessionId: () => id } },
		),
	);
	withSession(id, () => stub.fire(WORK_READY, layerHolding(`/trees/${id}`)));
	return stub;
}

describe("review state in two hosted conversations of one folder", () => {
	it("keeps each conversation's working layer and listener after the other starts", async () => {
		const a = await conversation("a");
		await conversation("b");

		expect(
			a.handlers.get(WORK_READY)?.length,
			"b's start leaves a still listening for its working layer",
		).toBe(1);
		const standing = await withSession("a", () =>
			treeStandingFor(REPO, COMMIT),
		);
		expect(standing, "a's standing reads a's own working layer").toEqual({
			kind: "cut",
			path: "/trees/a",
		});
		expect(
			await withSession("b", () => treeStandingFor(REPO, COMMIT)),
		).toEqual({ kind: "cut", path: "/trees/b" });
	});

	it("names each conversation's attachments by its own session", async () => {
		await conversation("a");
		await conversation("b");

		expect(withSession("a", sessionKey)).toBe("a");
		expect(withSession("b", sessionKey)).toBe("b");
	});

	it("lets a released conversation's working layer go", async () => {
		await conversation("a");
		await conversation("b");
		releaseSession("b");

		expect(
			await withSession("b", () => treeStandingFor(REPO, COMMIT)),
			"a released conversation's slot starts empty, holding nothing of the last",
		).toMatchObject({ kind: "unknown" });
	});
});
