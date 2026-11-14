/**
 * The install check's reading of its own checkout: HEAD from git's
 * files, and how far behind its upstream it is, counted by git only once
 * either has moved.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	commitsBehindReader,
	headOf,
} from "../../../extensions/install-check-workflow/probe.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

let origin: string | undefined;
const made: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	disposeRepo(origin);
	origin = undefined;
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A clone tracking a fresh repository's main. */
async function cloned(): Promise<string> {
	origin = await freshRepo();
	const parent = mkdtempSync(join(tmpdir(), "probe-"));
	made.push(parent);
	const clone = join(parent, "clone");
	await git(parent, "clone", "-q", origin, clone);
	return clone;
}

/** A new commit on the origin's main, fetched into `clone`. */
async function movedUpstream(clone: string): Promise<void> {
	writeFileSync(join(origin ?? "", `file-${Date.now()}`), "x");
	await git(origin ?? "", "add", "-A");
	await git(origin ?? "", "commit", "-qm", "moved");
	await git(clone, "fetch", "-q");
}

describe("the install check's checkout", () => {
	it("reads HEAD as git says it", async () => {
		const clone = await cloned();
		expect(await headOf(clone)).toBe(await git(clone, "rev-parse", "HEAD"));
	});

	it("counts the commits behind again once the upstream moves", async () => {
		const clone = await cloned();
		const behind = commitsBehindReader();
		expect(await behind(clone), "as cloned").toBe(0);
		await movedUpstream(clone);
		expect(await behind(clone), "after a fetch").toBe(1);
	});

	it("asks git nothing while neither HEAD nor the upstream has moved", async () => {
		const clone = await cloned();
		await movedUpstream(clone);
		const behind = commitsBehindReader();
		expect(await behind(clone), "counted once").toBe(1);
		vi.stubEnv("PATH", "/nowhere");
		expect(await behind(clone), "with no git to ask").toBe(1);
	});
});
