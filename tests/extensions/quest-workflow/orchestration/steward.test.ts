/**
 * Making a quest the person's steward, set on the quest through the
 * tool rather than by hand, so every session below it finds the same
 * steward by walking up its parents.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../../extensions/quest-workflow/transitions.ts";
import { parseQuestFrontMatter } from "../../../../lib/internal/quest/documents/frontmatter.ts";
import { fakePi } from "../../../support/fake-pi.ts";
import { createEnvGuard } from "../_helpers.ts";

let tmpRoot: string;

function fakeCtx() {
	return {
		cwd: tmpRoot,
		sessionManager: { getSessionId: () => "sess-1" },
	} as unknown as Parameters<typeof handle>[2];
}

function questsRoot() {
	return join(tmpRoot, "quests");
}

async function run(params: Parameters<typeof handle>[3]) {
	return handle(
		createQuestState({ questsRoot: questsRoot() }),
		fakePi(),
		fakeCtx(),
		params,
	);
}

async function made(): Promise<string> {
	const result = await run({ action: "create", title: "The Steward" });
	if (!result.ok) throw new Error(result.guidance);
	return (result.details as { id: string }).id;
}

function readmeOf(id: string): string {
	return readFileSync(join(questsRoot(), id, "README.md"), "utf8");
}

function stewardOf(id: string) {
	return parseQuestFrontMatter(readmeOf(id))?.frontMatter.steward;
}

function said(result: Awaited<ReturnType<typeof run>>): string {
	return result.ok ? result.message : result.guidance;
}

const envGuard = createEnvGuard();
let savedHome: string | undefined;
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "steward-"));
	savedHome = process.env.HOME;
	process.env.HOME = tmpRoot;
});
afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("making a quest the person's steward", () => {
	it("is set, said, and cleared again", async () => {
		const id = await made();
		const before = stewardOf(id);
		const set = await run({ action: "config", id, ref: "steward=true" });
		const marked = stewardOf(id);
		const report = await run({ action: "config", id });
		const back = await run({ action: "config", id, ref: "steward=false" });
		expect(
			[before, set.ok, marked, said(report), back.ok, stewardOf(id)],
			"unset, set, true, reported, set, unset",
		).toEqual([
			undefined,
			true,
			true,
			expect.stringContaining("It is the person's steward."),
			true,
			undefined,
		]);
	});

	it("says so when it is already the steward, writing nothing twice", async () => {
		const id = await made();
		await run({ action: "config", id, ref: "steward=true" });
		const readme = readmeOf(id);
		const again = await run({ action: "config", id, ref: "steward=true" });
		expect(
			[said(again), readmeOf(id) === readme],
			"already, and unchanged",
		).toEqual([
			expect.stringContaining("already is the person's steward"),
			true,
		]);
	});

	it("refuses a value it doesn't know, changing nothing", async () => {
		const id = await made();
		const result = await run({ action: "config", id, ref: "steward=yes" });
		expect(
			[result.ok, said(result), stewardOf(id)],
			"refused, naming the setting, and unchanged",
		).toEqual([false, expect.stringContaining("steward=true"), undefined]);
	});

	// Written by hand as a string, the parser keeps it in _extra rather
	// than reading it as a steward, so config names the slip, a rewrite
	// keeps it, and setting it through the tool replaces it.
	it("names a steward written by hand as text, then sets it right", async () => {
		const id = await made();
		const path = join(questsRoot(), id, "README.md");
		writeFileSync(
			path,
			readmeOf(id).replace(/^id: .*$/m, '$&\nsteward: "yes"'),
		);
		const report = await run({ action: "config", id });
		await run({ action: "config", id, ref: "subjects=steward-slip" });
		// A rewrite may say the text plainly, quoted or not.
		const slip = /^steward: "?yes"?$/m;
		const kept = slip.test(readmeOf(id));
		await run({ action: "config", id, ref: "steward=true" });
		expect(
			[said(report), kept, stewardOf(id), slip.test(readmeOf(id))],
			"named, kept through a rewrite, then a steward with the slip gone",
		).toEqual([
			expect.stringContaining(
				'says steward: "yes", but only true makes a steward',
			),
			true,
			true,
			false,
		]);
	});

	it("clears a steward written by hand as text when set false", async () => {
		const id = await made();
		const path = join(questsRoot(), id, "README.md");
		writeFileSync(
			path,
			readmeOf(id).replace(/^id: .*$/m, '$&\nsteward: "yes"'),
		);
		const cleared = await run({ action: "config", id, ref: "steward=false" });
		expect(
			[said(cleared), /^steward:/m.test(readmeOf(id))],
			"cleared, the slip gone",
		).toEqual([expect.stringContaining("now is not"), false]);
	});

	it("says in the plain report how to set it", async () => {
		const result = await run({ action: "config" });
		expect(said(result), "the report names the setting").toContain(
			"steward=true",
		);
	});
});
