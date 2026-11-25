/**
 * A round's tree holds the files the change writes.
 *
 * World's provider cuts a snapshot sparse: World's top-level files and
 * the zones it is asked for. A round asked it for no files, so two
 * World councils on 25 November read a tree with no areas/ folder and
 * none of the change in it (2MWIBZ). The round now asks for the head's
 * files, and when a provider refuses them it asks for the commit alone
 * and says what the tree lacks, rather than refusing the round.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	filesToRead,
	forgetWorkLayer,
	readFrom,
	saidOfTree,
	stackFilesToRead,
	treeForRound,
	watchForWorkLayer,
} from "../../../../extensions/review-integration/work.ts";
import type { DiffFile } from "../../../../lib/core/review/index.ts";
import {
	type HeldTree,
	type TreeRequest,
	treeIdentity,
} from "../../../../lib/core/work/index.ts";
import { OFF } from "../../../../lib/internal/fence/fence-stage.ts";
import { SANDBOX_VARIABLE } from "../../../../lib/internal/sandbox/sandbox.ts";
import { freshRepo } from "../../../support/git-fixture.ts";

const KEY = "github:Jitsusama/agentic-harness.pi";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "review-config-home-"));
	vi.stubEnv("XDG_CONFIG_HOME", home);
	// Unfenced, whatever runs the tests: inside the fence git is refused in
	// a repo that isn't a cut tree, which these fixtures never are.
	vi.stubEnv(SANDBOX_VARIABLE, OFF);
	forgetWorkLayer();
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
	forgetWorkLayer();
});

/** A checkout of this repo with one commit, and that commit. */
async function checkoutAt(): Promise<{ path: string; head: string }> {
	const path = await freshRepo("round-files");
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
	git("remote", "add", "origin", `git@github.com:${KEY.slice(7)}.git`);
	return { path, head: git("rev-parse", "HEAD") };
}

/**
 * A working layer that records every snapshot asked of it, and refuses
 * any asked to hold a file under `refused`, as World's provider refuses
 * a file in no zone.
 */
function announceLayer(refused?: string): TreeRequest[] {
	const asked: TreeRequest[] = [];
	const layer = {
		registerTreeProvider() {},
		listTreeProviders: () => [],
		broker: () => ({
			held: (): HeldTree[] => [],
			async ensure(request: TreeRequest): Promise<HeldTree> {
				asked.push(request);
				const paths = request.intent === "snapshot" ? request.paths : undefined;
				const bad =
					refused === undefined
						? []
						: (paths ?? []).filter((path) => path.startsWith(refused));
				if (bad.length > 0) {
					throw new Error(`No zone at this commit holds ${bad.join(", ")}.`);
				}
				const identity = treeIdentity(request);
				return {
					identity,
					path: `/trees/${identity.key}`,
					providerId: "world",
				};
			},
			release() {
				throw new Error("not for this test");
			},
			cutHere: () => true,
		}),
	};
	const listeners: ((data: unknown) => void)[] = [];
	watchForWorkLayer({
		events: {
			on(_name: string, fn: (data: unknown) => void) {
				listeners.push(fn);
				return () => {};
			},
			emit() {},
		},
	} as never);
	// The one listener the module keeps is for the layer's announcement.
	for (const fn of listeners) fn(layer);
	return asked;
}

function file(
	oldPath: string | undefined,
	newPath: string | undefined,
): DiffFile {
	return {
		...(oldPath === undefined ? {} : { oldPath }),
		...(newPath === undefined ? {} : { newPath }),
		status: "modified",
		hunks: [],
	};
}

describe("the files a round's tree must hold", () => {
	it("are each file the change writes at its head, once each", () => {
		expect(
			filesToRead({
				files: [
					file("areas/a/x.ts", "areas/a/x.ts"),
					file("areas/b/old.ts", "areas/c/new.ts"),
					file("areas/d/gone.ts", undefined),
					file(undefined, "areas/a/x.ts"),
				],
			}),
		).toEqual(["areas/a/x.ts", "areas/c/new.ts"]);
	});

	it("are, for a stack, only those its tip still holds", () => {
		expect(
			stackFilesToRead([
				{
					files: [
						file(undefined, "areas/a/added.ts"),
						file(undefined, "areas/b/moved.ts"),
						file("areas/c/kept.ts", "areas/c/kept.ts"),
					],
				},
				{
					files: [
						file("areas/a/added.ts", undefined),
						file("areas/b/moved.ts", "areas/d/moved.ts"),
						file("areas/c/kept.ts", "areas/c/kept.ts"),
					],
				},
			]),
		).toEqual(["areas/c/kept.ts", "areas/d/moved.ts"]);
	});

	it("asks the snapshot for the change's files", async () => {
		const checkout = await checkoutAt();
		const asked = announceLayer();
		const tree = await treeForRound(
			{ key: KEY, localPath: checkout.path },
			checkout.head,
			checkout.path,
			["areas/a/x.ts"],
		);

		if ("refusal" in tree) throw new Error(`refused: ${tree.refusal}`);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatchObject({
			intent: "snapshot",
			commit: checkout.head,
			paths: ["areas/a/x.ts"],
		});
		expect(saidOfTree(tree)).toBeUndefined();
	});

	it("asks for the commit alone, and says what it lacks, when the files are refused", async () => {
		const checkout = await checkoutAt();
		const asked = announceLayer(".github/");
		const tree = await treeForRound(
			{ key: KEY, localPath: checkout.path },
			checkout.head,
			checkout.path,
			["areas/a/x.ts", ".github/CODEOWNERS"],
		);

		if ("refusal" in tree) throw new Error(`refused: ${tree.refusal}`);
		expect(tree.path).toMatch(/^\/trees\/snapshot-/);
		expect(
			asked.map((one) => (one.intent === "snapshot" ? one.paths : "worktree")),
		).toEqual([["areas/a/x.ts", ".github/CODEOWNERS"], undefined]);
		// At the commit, so no caveat, but the round lacked the change's
		// files, so it is recorded as unpinned and no gate counts it as a
		// read of the head.
		expect(tree.caveat).toBeUndefined();
		expect(saidOfTree(tree)).toContain(
			"No zone at this commit holds .github/CODEOWNERS",
		);
		const read = readFrom(tree, checkout.head, undefined);
		expect(read.witness).toBe(checkout.head);
		expect(read.unpinned).toContain(".github/CODEOWNERS");
	});

	it("asks for no files when the change names none", async () => {
		const checkout = await checkoutAt();
		const asked = announceLayer();
		await treeForRound(
			{ key: KEY, localPath: checkout.path },
			checkout.head,
			checkout.path,
			[],
		);

		expect(asked).toHaveLength(1);
		expect(asked[0]).not.toHaveProperty("paths");
	});
});
