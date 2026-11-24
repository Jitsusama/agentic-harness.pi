/**
 * A handover's done file: paths within home, and what another machine's
 * done file must hold before anything here trusts it.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	doneFileOf,
	doneNames,
	flagIn,
	type Handover,
	handoverOf,
	readHandover,
	underHome,
	withinHome,
	writeHandover,
} from "../../../../lib/internal/carry/handover.ts";

const HEAD = "a".repeat(40);

const handover: Handover = {
	session: "s-1",
	quest: "QEST-20261107-CARRY1",
	cwd: "~/src/app",
	sessionFile: "2026-11-07_s-1.jsonl",
	trees: [
		{
			path: "~/src/app",
			origin: "git@github.com:Jitsusama/app.git",
			branch: "topic/one",
			head: HEAD,
			bundle: "app-1a2b3c4d.bundle",
			needs: [{ commit: "b".repeat(40), on: "origin/main" }],
			patch: "app-1a2b3c4d.patch",
		},
	],
};

/** A done file holding `said`, as another machine's share left it. */
function arrived(said: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "handover-"));
	const file = join(dir, "s-1.done.json");
	writeFileSync(file, JSON.stringify(said));
	return file;
}

describe("a handover", () => {
	it("is in the quest's scratch, in a folder named for the machine that wrote it", () => {
		expect(handoverOf("/cache/ws", "QEST-1", "aquifer")).toBe(
			"/cache/ws/QEST-1/handover/aquifer",
		);
		expect(doneFileOf("/h", "s-1")).toBe("/h/s-1.done.json");
		expect(
			doneNames(["s-1.done.json", "app.bundle", "QEST-1.done.json"]),
		).toEqual(["s-1", "QEST-1"]);
	});

	it("writes paths within home, which the other machine makes whole under its own", () => {
		expect(withinHome("/home/joel/src/app", "/home/joel")).toBe("~/src/app");
		expect(withinHome("/home/joel", "/home/joel")).toBe("~");
		expect(withinHome("/srv/app", "/home/joel")).toBe("/srv/app");
		expect(underHome("~/src/app", "/Users/joel")).toBe("/Users/joel/src/app");
		expect(underHome("~", "/Users/joel")).toBe("/Users/joel");
		expect(underHome("/srv/app", "/Users/joel")).toBe("/srv/app");
	});

	it("reads back the done file it wrote", () => {
		const dir = mkdtempSync(join(tmpdir(), "handover-"));

		const file = writeHandover(dir, handover);

		expect(file).toBe(join(dir, "s-1.done.json"));
		expect(readHandover(file)).toEqual(handover);
	});

	it("reads back the fence it ran under and its quest's notes", () => {
		const dir = mkdtempSync(join(tmpdir(), "handover-"));
		const moved: Handover = {
			...handover,
			fence: "strict",
			notes: [
				{ text: "retry lives in supervisor.ts", tags: ["retry"] },
				{ text: "the gate is host-gate.sh", tags: [], source: "AGENTS.md" },
			],
		};

		expect(readHandover(writeHandover(dir, moved))).toEqual(moved);
	});

	it("trusts nothing in another machine's done file that could reach elsewhere", () => {
		const tree = handover.trees[0];
		for (const [why, said] of [
			["a path climbing out", { ...handover, cwd: "~/../etc" }],
			["a relative path", { ...handover, cwd: "src/app" }],
			[
				"a bundle in another folder",
				{ ...handover, trees: [{ ...tree, bundle: "../x.bundle" }] },
			],
			[
				"a session file in another folder",
				{ ...handover, sessionFile: "/etc/passwd" },
			],
			[
				"a branch climbing out",
				{ ...handover, trees: [{ ...tree, branch: "topic/../../x" }] },
			],
			[
				"a head that isn't a commit",
				{ ...handover, trees: [{ ...tree, head: "HEAD~1" }] },
			],
			["no trees", { ...handover, trees: undefined }],
			["a fence no harness names", { ...handover, fence: "loose" }],
			["notes that aren't a list", { ...handover, notes: "remember" }],
			[
				"a note with no words",
				{ ...handover, notes: [{ text: " ", tags: [] }] },
			],
			[
				"a note whose tags aren't words",
				{ ...handover, notes: [{ text: "x", tags: [1] }] },
			],
		] as const) {
			expect(readHandover(arrived(said)), why).toBeUndefined();
		}
		expect(readHandover(join(tmpdir(), "no-such.done.json"))).toBeUndefined();
	});

	it("reads a tree naming what git could take as a flag, naming it for that tree alone to be refused", () => {
		const tree = handover.trees[0];
		const needing = (on: string) => [{ commit: "b".repeat(40), on }];
		for (const [why, flagged, flag] of [
			["a branch", { ...tree, branch: "-rf" }, "-rf"],
			[
				"a branch with such a part",
				{ ...tree, branch: "topic/--orphan" },
				"topic/--orphan",
			],
			[
				"a needed remote branch's branch",
				{ ...tree, needs: needing("origin/--upload-pack=./PWNED") },
				"origin/--upload-pack=./PWNED",
			],
			[
				"a needed remote branch's remote",
				{ ...tree, needs: needing("-x/main") },
				"-x/main",
			],
			["an origin", { ...tree, origin: "--upload-pack=x" }, "--upload-pack=x"],
		] as const) {
			const said = { ...handover, trees: [tree, flagged] };
			const read = readHandover(arrived(said));

			expect(read?.trees.map(flagIn), why).toEqual([undefined, flag]);
		}
	});
});
