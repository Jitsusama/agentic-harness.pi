/**
 * The subjects a quest's sessions say they work on, set on the quest so
 * every session on it declares the same and a need finds them by them.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../../extensions/quest-workflow/transitions.ts";
import { parseQuestFrontMatter } from "../../../../lib/internal/quest/documents/frontmatter.ts";
import { questAddress } from "../../../../lib/mesh/address.ts";
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
	const result = await run({ action: "create", title: "Needs Find Cells" });
	if (!result.ok) throw new Error(result.guidance);
	return (result.details as { id: string }).id;
}

function extraOf(id: string) {
	const readme = readFileSync(join(questsRoot(), id, "README.md"), "utf8");
	return parseQuestFrontMatter(readme)?.frontMatter._extra;
}

function subjectsOf(id: string) {
	return extraOf(id)?.subjects;
}

/** Owner lines, as cadence writes them, in the file this test reads. */
function owners(...lines: string[]) {
	writeFileSync(ownersAt(), lines.map((line) => `${line}\n`).join(""));
}

function ownersAt() {
	return join(tmpRoot, "owners.txt");
}

const said = (result: Awaited<ReturnType<typeof run>>) =>
	result.ok ? result.message : result.guidance;

const envGuard = createEnvGuard();
let savedHome: string | undefined;
let savedOwners: string | undefined;
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "subjects-"));
	savedHome = process.env.HOME;
	savedOwners = process.env.PI_OWNERS_FILE;
	process.env.HOME = tmpRoot;
	process.env.PI_OWNERS_FILE = ownersAt();
});
afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	if (savedOwners !== undefined) process.env.PI_OWNERS_FILE = savedOwners;
	else delete process.env.PI_OWNERS_FILE;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("the subjects a quest's sessions declare", () => {
	it("are set as a list, each trimmed, once each, and cleared again", async () => {
		const id = await made();
		const before = subjectsOf(id);
		const set = await run({
			action: "config",
			id,
			ref: "subjects= mycelium:hubs , needs,,needs",
		});
		const listed = subjectsOf(id);
		const cleared = await run({ action: "config", id, ref: "subjects=" });
		expect(
			[before, set.ok, listed, cleared.ok, subjectsOf(id)],
			"unset, set, listed, cleared, unset",
		).toEqual([undefined, true, ["mycelium:hubs", "needs"], true, undefined]);
	});

	it("say what was set, and that a need finds the sessions by them", async () => {
		const id = await made();
		const result = await run({ action: "config", id, ref: "subjects=needs" });
		expect(said(result)).toMatch(/needs/);
		expect(said(result)).toMatch(/from their next refresh/);
	});

	it("refuse more than the node reads, or one it would pass over, changing nothing", async () => {
		const id = await made();
		const many = Array.from({ length: 13 }, (_, at) => `s${at}`).join(",");
		const tooMany = await run({
			action: "config",
			id,
			ref: `subjects=${many}`,
		});
		const tooLong = await run({
			action: "config",
			id,
			ref: `subjects=${"x".repeat(121)}`,
		});
		expect(
			[tooMany.ok, tooLong.ok, subjectsOf(id)],
			"both refused, nothing set",
		).toEqual([false, false, undefined]);
		expect(said(tooMany)).toMatch(/12/);
	});

	it("refuse what the owner prefixes would crowd out of the twelve places, changing nothing", async () => {
		const id = await made();
		const address = questAddress(id);
		owners(
			...[0, 1, 2, 3].map((at) => `owned${at}.=${address}`),
			"else.=80ECO2",
		);
		const list = (count: number) =>
			Array.from({ length: count }, (_, at) => `s${at}`).join(",");
		const crowded = await run({
			action: "config",
			id,
			ref: `subjects=${list(9)}`,
		});
		const before = subjectsOf(id);
		const room = await run({
			action: "config",
			id,
			ref: `subjects=${list(8)}`,
		});
		const report = await run({ action: "config", id });
		expect(
			[crowded.ok, before, room.ok, subjectsOf(id)],
			"crowded refused, nothing set, then room for eight",
		).toEqual([false, undefined, true, list(8).split(",")]);
		expect(said(crowded)).toMatch(/owned0\..*4 of the 12 places/);
		expect(said(report)).toMatch(
			/owning owned0\., owned1\., owned2\., owned3\./,
		);
	});

	it("come back from the README exactly as said, however YAML would read them bare", async () => {
		const id = await made();
		const awkward = ["a: b", "#c", "[d]", "2026", "true", "---", "'q'"];
		const result = await run({
			action: "config",
			id,
			ref: `subjects=${awkward.join(",")}`,
		});
		expect([result.ok, subjectsOf(id)]).toEqual([true, awkward]);
	});

	it("keep the README's other front matter as it was, set or cleared", async () => {
		const id = await made();
		const file = join(questsRoot(), id, "README.md");
		const text = readFileSync(file, "utf8");
		writeFileSync(file, text.replace(/\n---\n/, "\nflavour: lime\n---\n"));
		await run({ action: "config", id, ref: "subjects=needs" });
		const set = extraOf(id);
		await run({ action: "config", id, ref: "subjects=" });
		expect([set, extraOf(id)]).toEqual([
			{ flavour: "lime", subjects: ["needs"] },
			{ flavour: "lime" },
		]);
	});

	it("are named in the refusal of a ref that is neither", async () => {
		const id = await made();
		const result = await run({ action: "config", id, ref: "subject=needs" });
		expect([result.ok, said(result)]).toEqual([
			false,
			expect.stringContaining("subjects=a,b"),
		]);
	});

	it("are said for a named quest, and how to set them in the plain report", async () => {
		const id = await made();
		await run({ action: "config", id, ref: "subjects=needs,hubs" });
		const report = await run({ action: "config", id });
		const plain = await run({ action: "config" });
		expect([said(report), said(plain)]).toEqual([
			expect.stringContaining("needs, hubs"),
			expect.stringContaining("subjects="),
		]);
	});
});
