/**
 * What the work tool says a session did: a commit and a push, each named
 * by the repository's key, for the session's presence to carry.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SESSION_DID } from "../../../lib/internal/session/events.ts";
import { git } from "../../support/git-fixture.ts";
import { cut, emitted, scratchDir, work } from "./worked.ts";

/** What the tool said it did, by kind, place and title. */
function did() {
	return emitted()
		.filter((one) => one.event === SESSION_DID)
		.map((one) => {
			const { kind, where, title } = one.data as Record<string, unknown>;
			return { kind, where, title };
		});
}

describe("the work tool's events", () => {
	it("says a commit under its repository's key", async () => {
		const { path } = await cut();
		await git(
			path,
			"remote",
			"add",
			"origin",
			"https://github.com/test/worked.git",
		);
		writeFileSync(join(path, "notes.txt"), "work\n");
		await work({ action: "record", subject: "docs: add notes" });
		expect(did()).toEqual([
			{ kind: "commit", where: "github:test/worked", title: "docs: add notes" },
		]);
	});

	it("says a push by its branch, and nothing for a refused commit", async () => {
		const { path } = await cut();
		const origin = join(scratchDir(), "origin.git");
		await git(scratchDir(), "init", "-q", "--bare", origin);
		// Named as a hosted repository, and pushed to the bare one beside it.
		await git(
			path,
			"remote",
			"add",
			"origin",
			"https://github.com/test/worked.git",
		);
		await git(path, "config", "remote.origin.pushurl", origin);
		await work({ action: "record", subject: "Added notes." });
		await git(path, "commit", "-q", "--allow-empty", "-m", "work");
		await work({ action: "push" });
		expect(did().map((one) => [one.kind, one.title])).toEqual([
			["push", "topic"],
		]);
	});
});
