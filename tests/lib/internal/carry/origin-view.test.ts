/**
 * git run in a tree as arrive runs it, through real git and sh: fed its
 * input, and stopped once a call to a remote runs past its time.
 */

import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitIn } from "../../../../lib/internal/carry/origin-view.ts";
import { git } from "../../../support/git-fixture.ts";
import { exec, folder, removeAll } from "./support/machines.ts";

const made: string[] = [];
afterEach(() => removeAll(made));

/** A tree with nothing in it, for git to run in. */
async function tree(): Promise<string> {
	const path = folder(made, "view");
	await git(path, "init", "-q");
	return path;
}

/** A remote that takes the call and never answers, over git's ext. */
const SILENT = ["-c", "protocol.ext.allow=always", "ls-remote"];

describe("git in a tree, as arrive runs it", () => {
	it("stops a remote that never answers once its time is up, saying so", async () => {
		const path = await tree();
		const started = Date.now();

		const done = await gitIn(exec, path)
			.within(1)
			.run(...SILENT, "ext::sh -c sleep% 30");

		expect(done.code).not.toBe(0);
		expect(done.stderr).toMatch(/^git was stopped after 1 seconds\./);
		expect(Date.now() - started, "well before the remote would").toBeLessThan(
			15_000,
		);
		expect(
			readdirSync(join(path, ".git")).filter((name) =>
				name.startsWith("carry-in-"),
			),
			"its input is gone",
		).toEqual([]);
	});

	it("lets git that ends in its time say what it said", async () => {
		const path = await tree();

		const done = await gitIn(exec, path)
			.within(30)
			.fed(["one", "two"], "hash-object", "--stdin");

		expect(done.code).toBe(0);
		expect(done.stdout.trim(), "the blob of its lines, each ended").toBe(
			createHash("sha1").update("blob 8\0one\ntwo\n").digest("hex"),
		);
	});
});
