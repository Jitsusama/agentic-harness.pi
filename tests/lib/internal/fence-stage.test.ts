/**
 * Which pis the fence takes by default in its first stage, and how a
 * stray PI_SANDBOX reads.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	askedSandbox,
	inFirstStage,
	listedForStage,
	listForStage,
	listSpawnForStage,
	STAGE_VARIABLE,
	settleStage,
	stagedSessions,
	startedSession,
	unlistForStage,
	withoutOff,
} from "../../../lib/internal/fence-stage.ts";
import { sandboxName } from "../../../lib/internal/sandbox.ts";

const NAMES = { fence: "fence", known: ["fence", "strict"] };
const SESSION = "01a1cbd0-f2c7-7eea-9706-777bda77c893";
const OTHER = "01a1d852-4fbc-777f-9a68-3da5f304b0a2";
const staged = () => true;
const unstaged = () => false;

let folder: string;
beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "fence-stage-"));
});

describe("how PI_SANDBOX reads", () => {
	it("keeps a sandbox it names, staged or not", () => {
		for (const name of NAMES.known) {
			for (const stage of [staged, unstaged]) {
				expect(
					askedSandbox({ PI_SANDBOX: name }, NAMES, stage),
					`${name} wasn't kept`,
				).toEqual({ name });
			}
		}
	});

	it("runs as they are with off, even in the stage", () => {
		expect(
			askedSandbox({ PI_SANDBOX: "off" }, NAMES, staged),
			"off was fenced",
		).toEqual({});
	});

	it("reads empty or unknown as the fence, saying so and the way back", () => {
		for (const given of ["", " ", "fenced", "none"]) {
			const read = askedSandbox({ PI_SANDBOX: given }, NAMES, unstaged);
			expect(read.name, `${JSON.stringify(given)} wasn't fenced`).toBe("fence");
			expect(read.note, "the note doesn't name the value").toContain(
				`PI_SANDBOX=${JSON.stringify(given)}`,
			);
			expect(read.note, "the note doesn't name the way back").toContain(
				"PI_SANDBOX=off",
			);
		}
	});

	it("fences an unset pi only in the stage", () => {
		expect(askedSandbox({}, NAMES, staged), "a staged pi ran as is").toEqual({
			name: "fence",
		});
		expect(
			askedSandbox({}, NAMES, unstaged),
			"an unstaged pi was fenced",
		).toEqual({});
	});

	it("names the sandbox decided, the stage's default included, for what reports it", () => {
		expect(sandboxName({}, staged), "a staged pi's sandbox").toBe("fence");
		expect(sandboxName({ PI_SANDBOX: "strict" }, unstaged)).toBe("strict");
		expect(sandboxName({ PI_SANDBOX: "off" }, staged)).toBeUndefined();
		expect(sandboxName({}, unstaged)).toBeUndefined();
	});
});

describe("what a pi hands on of PI_SANDBOX", () => {
	it("drops off alone, since it is one session's way back", () => {
		expect(withoutOff({ PATH: "/bin", PI_SANDBOX: " off " })).toEqual({
			PATH: "/bin",
		});
		const asked = { PATH: "/bin", PI_SANDBOX: "strict" };
		expect(withoutOff(asked), "a fence asked for was dropped").toBe(asked);
	});
});

describe("which pis are in the first stage", () => {
	it("takes a subagent, by either of its supervisor's marks", () => {
		for (const mark of [
			{ SUBAGENT_SUPERVISOR: "1" },
			{ SUBAGENT_RUN_ID: "run-1" },
		]) {
			expect(inFirstStage(mark, [], folder), "a subagent wasn't staged").toBe(
				true,
			);
		}
	});

	it("takes a listed session and leaves an unlisted one", () => {
		listForStage(SESSION, "by hand", folder);
		const argv = ["pi", "--session-id", SESSION];
		expect(inFirstStage({}, argv, folder), "a listed one wasn't").toBe(true);
		const other = ["pi", "--session-id", OTHER];
		expect(inFirstStage({}, other, folder), "an unlisted one was").toBe(false);
	});

	it("shows what is listed, and takes one off", () => {
		expect(stagedSessions(join(folder, "none")), "a missing folder").toEqual(
			[],
		);
		listForStage(SESSION, "by hand", folder);
		listForStage(OTHER, "by hand", folder);
		expect(stagedSessions(folder), "the listed ones").toEqual([SESSION, OTHER]);
		expect(unlistForStage(SESSION, folder), "it wasn't taken off").toBe(true);
		expect(unlistForStage(SESSION, folder), "it was taken off twice").toBe(
			false,
		);
		expect(stagedSessions(folder), "what's left").toEqual([OTHER]);
	});

	it("goes by the command line before an inherited PI_SESSION_ID", () => {
		listForStage(OTHER, "the asker", folder);
		const env = { PI_SESSION_ID: OTHER };
		expect(
			startedSession(env, ["pi", "--session", SESSION]),
			"the inherited id won",
		).toBe(SESSION);
		expect(
			inFirstStage(env, ["pi", "--session", SESSION], folder),
			"a child was staged by its asker's listing",
		).toBe(false);
		expect(startedSession(env, ["pi"]), "a host's id was missed").toBe(OTHER);
	});

	it("reads a session from its log's name", () => {
		const log = `/logs/--x--/2026-11-14T18-43-12-373Z_${SESSION}.jsonl`;
		expect(startedSession({}, ["pi", `--session=${log}`])).toBe(SESSION);
	});

	it("takes a spawn by its token, which names nothing unlisted", () => {
		const token = listSpawnForStage("quest spawn", folder);
		expect(
			inFirstStage({ [STAGE_VARIABLE]: token }, [], folder),
			"a listed token wasn't staged",
		).toBe(true);
		expect(
			inFirstStage({ [STAGE_VARIABLE]: OTHER }, [], folder),
			"a token nobody listed was staged",
		).toBe(false);
		expect(
			inFirstStage({ [STAGE_VARIABLE]: "../x" }, [], folder),
			"a path for a token was staged",
		).toBe(false);
	});

	it("lists a token's session by id as it starts, so a reopen stays fenced", () => {
		const token = listSpawnForStage("quest spawn", folder);
		const env = { [STAGE_VARIABLE]: token };
		expect(settleStage(env, SESSION, folder), "it wasn't listed").toBe(true);
		expect(listedForStage(SESSION, folder), "no listing by id").toBe(true);
		expect(settleStage(env, SESSION, folder), "it was listed twice").toBe(
			false,
		);
		const kept = JSON.parse(
			readFileSync(join(folder, `${SESSION}.json`), "utf8"),
		);
		expect(kept.why, "the listing doesn't say its token").toContain(token);
		expect(settleStage({}, OTHER, folder), "an untokened one was listed").toBe(
			false,
		);
	});
});
