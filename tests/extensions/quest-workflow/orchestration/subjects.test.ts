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
import { LONGEST_WORD } from "../../../../lib/mesh/need-route.ts";
import {
	LONGEST_SUBJECT,
	MOST_SUBJECTS,
} from "../../../../lib/mesh/subjects.ts";
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
		// Each routes, so only the cap can refuse them.
		const many = Array.from(
			{ length: MOST_SUBJECTS + 1 },
			(_, at) => `area${at}`,
		).join(",");
		const tooMany = await run({
			action: "config",
			id,
			ref: `subjects=${many}`,
		});
		// One that routes, so only the length refuses it (#2220's sixth
		// council, F50), and one past the cap, so the cap is where it
		// says (seventh council, F63).
		const long = `x:${"lines-".repeat(19)}lines`;
		expect(long, "one past the cap").toHaveLength(LONGEST_SUBJECT + 1);
		const tooLong = await run({
			action: "config",
			id,
			ref: `subjects=${long}`,
		});
		expect(
			[tooMany.ok, tooLong.ok, subjectsOf(id)],
			"both refused, nothing set",
		).toEqual([false, false, undefined]);
		expect(said(tooMany)).toMatch(
			new RegExp(`reads at most ${MOST_SUBJECTS} subjects`),
		);
		expect(said(tooLong), "refused for its length").toMatch(
			new RegExp(`at most ${LONGEST_SUBJECT} characters`),
		);
	});

	it("refuse a subject whose narrowest part names no work, changing nothing", async () => {
		const id = await made();
		const result = await run({
			action: "config",
			id,
			ref: "subjects=needs,x:can,hooks:after",
		});
		expect([result.ok, subjectsOf(id)], "refused, nothing set").toEqual([
			false,
			undefined,
		]);
		expect(said(result), "each named").toMatch(/x:can, hooks:after/);
	});

	// Routing keeps no word past LONGEST_WORD, so one such names no work.
	it("refuse a subject whose one word runs past the longest kept", async () => {
		const id = await made();
		const long = `x:${"a".repeat(LONGEST_WORD + 1)}`;
		const result = await run({ action: "config", id, ref: `subjects=${long}` });
		expect([result.ok, subjectsOf(id)], "refused, nothing set").toEqual([
			false,
			undefined,
		]);
		expect(said(result)).toContain(long);
	});

	// A hub takes a need saying every word of its subject, and no need
	// keeps one past LONGEST_WORD, so its hub could take none.
	it("refuse a subject with any word past the longest kept, naming it", async () => {
		const id = await made();
		const word = "a".repeat(LONGEST_WORD + 1);
		const result = await run({
			action: "config",
			id,
			ref: `subjects=needs,x:${word}-lines`,
		});
		expect([result.ok, subjectsOf(id)], "refused, nothing set").toEqual([
			false,
			undefined,
		]);
		expect(said(result), "the word named").toContain(
			`${word} in x:${word}-lines`,
		);
	});

	// Words are read lowercased, but the writer looks for the word as
	// written (#2220's sixth council, F59).
	it("refuse a subject with a word past the longest kept, naming it as written", async () => {
		const id = await made();
		const word = `Ab${"c".repeat(LONGEST_WORD)}`;
		const result = await run({
			action: "config",
			id,
			ref: `subjects=x:${word}-lines`,
		});
		expect(said(result), "the word as written").toContain(
			`${word} in x:${word}-lines`,
		);
	});

	// Mending one cause shouldn't meet a refusal for the other (#2220's
	// seventh council, F71).
	it("refuse subjects naming no work and with a word past the longest kept at once, naming both", async () => {
		const id = await made();
		const word = "a".repeat(LONGEST_WORD + 1);
		const result = await run({
			action: "config",
			id,
			ref: `subjects=x:can,x:${word}-lines`,
		});
		expect([result.ok, subjectsOf(id)], "refused, nothing set").toEqual([
			false,
			undefined,
		]);
		expect(said(result), "the one naming no work").toMatch(
			/x:can holds none there/,
		);
		expect(said(result), "the over-long word").toContain(
			`${word} in x:${word}-lines`,
		);
	});

	// No need keeps a joined id past LONGEST_WORD either, and one with a
	// number is said only whole, so its hub could take none (#2220's
	// sixth council, F57).
	it("refuse a subject joining a number into an id past the longest kept, naming it", async () => {
		const id = await made();
		const joined = `${"a".repeat(LONGEST_WORD - 6)}-leg-26`;
		const result = await run({
			action: "config",
			id,
			ref: `subjects=x:${joined}`,
		});
		expect([result.ok, subjectsOf(id)], "refused, nothing set").toEqual([
			false,
			undefined,
		]);
		expect(said(result), "the id named").toContain(`${joined} in x:${joined}`);
	});

	// One with no number is said by its parts, so its hub takes a need.
	it("set a subject joining words into an id past the longest kept", async () => {
		const id = await made();
		const joined = `x:${"a".repeat(LONGEST_WORD - 5)}-lines`;
		const result = await run({
			action: "config",
			id,
			ref: `subjects=${joined}`,
		});
		expect([result.ok, subjectsOf(id)], "set").toEqual([true, [joined]]);
	});

	it("set a subject whose one word is as long as the longest kept", async () => {
		const id = await made();
		const longest = `x:${"a".repeat(LONGEST_WORD)}`;
		const result = await run({
			action: "config",
			id,
			ref: `subjects=${longest}`,
		});
		expect([result.ok, subjectsOf(id)], "set").toEqual([true, [longest]]);
	});

	it("refuse a service unit by its name, saying its type is set aside", async () => {
		const id = await made();
		const result = await run({
			action: "config",
			id,
			ref: "subjects=x:ab.service",
		});
		expect(result.ok).toBe(false);
		expect(said(result), "its type set aside").toMatch(
			/a \.service ending set aside/,
		);
		expect(said(result), "the unit named").toMatch(
			/x:ab\.service holds none there/,
		);
	});

	// What the quest owns is the machine's config, which subjects= can't
	// change, so the report names only what the README declares.
	it("name those the README declares that name no work, and none it owns", async () => {
		const id = await made();
		// An owned prefix as common as after routes nothing either.
		owners(`after.=${questAddress(id)}`);
		const file = join(questsRoot(), id, "README.md");
		const text = readFileSync(file, "utf8");
		writeFileSync(
			file,
			text.replace(/\n---\n/, "\nsubjects:\n  - needs\n  - x:can\n---\n"),
		);
		const report = await run({ action: "config", id });
		expect(said(report)).toMatch(/, of which x:can names no work a need/);
		expect(said(report), "the owned prefix").toMatch(/owning after\./);
	});

	// One set by hand, or before config refused it, would leave its hub
	// quiet unseen (#2220's fifth council, F3, F7, F9 and F11).
	it("name one the README declares whose word past the longest kept leaves its hub taking none", async () => {
		const id = await made();
		const long = `x:${"a".repeat(LONGEST_WORD + 1)}-lines`;
		const file = join(questsRoot(), id, "README.md");
		const text = readFileSync(file, "utf8");
		writeFileSync(
			file,
			text.replace(/\n---\n/, `\nsubjects:\n  - needs\n  - ${long}\n---\n`),
		);
		const report = await run({ action: "config", id });
		expect(said(report)).toContain(
			`, of which ${long} says a word past ${LONGEST_WORD} characters, which no need keeps, so its hub takes none`,
		);
		expect(said(report), "not as naming no work").not.toMatch(/names no work/);
	});

	// An owned prefix is the machine's config, which subjects= can't
	// change, so it is never named as the README's (#2220's sixth
	// council, F46).
	it("name no owned prefix whose word past the longest kept leaves its hub taking none", async () => {
		const id = await made();
		const long = `${"a".repeat(LONGEST_WORD + 1)}-lines.`;
		owners(`${long}=${questAddress(id)}`);
		const report = await run({ action: "config", id });
		expect(said(report), "the owned prefix").toContain(`owning ${long}`);
		expect(said(report), "not as the README's").not.toMatch(
			/past \d+ characters/,
		);
	});

	it("refuse what the owner prefixes would crowd out of the twelve places, changing nothing", async () => {
		const id = await made();
		const address = questAddress(id);
		owners(
			...[0, 1, 2, 3].map((at) => `owned${at}.=${address}`),
			"else.=80ECO2",
		);
		const list = (count: number) =>
			Array.from({ length: count }, (_, at) => `area${at}`).join(",");
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

	it("are reported as left out once owner prefixes given later crowd them out", async () => {
		const id = await made();
		const declared = Array.from({ length: 10 }, (_, at) => `area${at}`);
		await run({ action: "config", id, ref: `subjects=${declared.join(",")}` });
		const address = questAddress(id);
		owners(...[0, 1, 2, 3].map((at) => `owned${at}.=${address}`));
		const report = await run({ action: "config", id });
		expect(said(report)).toMatch(/leaving out 2 its README declares/);
	});

	it("come back from the README exactly as said, however YAML would read them bare", async () => {
		const id = await made();
		const awkward = [
			"a: hubs",
			"#carry",
			"[deep]",
			"2026",
			"true",
			"--- lines",
			"'quoted'",
		];
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
