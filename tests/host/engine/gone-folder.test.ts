/**
 * Where a conversation opens when its log's folder is gone: the nearest
 * folder above that stands, or home, said to it once.
 */
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	FOLDER_GONE_TYPE,
	openStanding,
	standingFolder,
	toldOfMove,
} from "../../../host/engine/gone-folder.ts";
import type { SessionManager } from "../../../host/engine/pi-session.ts";

const folders: string[] = [];
/** Folders a test locked, opened again first so rm can read them. */
const locked: string[] = [];
afterEach(() => {
	for (const folder of locked.splice(0)) chmodSync(folder, 0o700);
	for (const folder of folders.splice(0))
		rmSync(folder, { recursive: true, force: true });
});

/** A log in `folder` whose session header names `cwd`, followed by a turn. */
function logNaming(folder: string, cwd: string | undefined): string {
	const file = join(folder, "log.jsonl");
	const header = { type: "session", version: 3, id: "s1", cwd };
	const turn = { type: "message", id: "m1", parentId: null };
	writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(turn)}\n`);
	return file;
}

function scratch(): string {
	const folder = mkdtempSync(join(tmpdir(), "gone-folder-"));
	folders.push(folder);
	return folder;
}

/** pi's open, as far as these read it: each call, and a log naming `cwd`. */
function piOpening(cwd: string) {
	const calls: (string | undefined)[][] = [];
	const open = (path: string, sessionDir?: string, cwdOverride?: string) => {
		calls.push([path, sessionDir, cwdOverride]);
		return {
			getCwd: () => cwdOverride ?? cwd,
			getSessionId: () => "s1",
		} as unknown as SessionManager;
	};
	return { calls, sessions: { open } };
}

describe("a conversation whose folder is gone", () => {
	it("opens in the nearest folder above that still stands", () => {
		const root = scratch();
		mkdirSync(join(root, "repo"));
		expect(standingFolder(join(root, "repo", "tree", "deep"), "/home/x")).toBe(
			join(root, "repo"),
		);
	});

	it("opens at home when only the root stands, never at the root", () => {
		const home = scratch();
		expect(standingFolder("/no-such-folder-here/tree", home)).toBe(home);
	});

	it("opens in the fallback when home is gone or is the root", () => {
		const fallback = scratch();
		expect(
			standingFolder("/no-such-folder-here/tree", "/no-such-home", fallback),
			"home gone",
		).toBe(fallback);
		expect(
			standingFolder("/no-such-folder-here/tree", "/", fallback),
			"home at the root",
		).toBe(fallback);
	});

	it("stays in a folder it can't read rather than read it as gone", () => {
		const root = scratch();
		const lock = join(root, "locked");
		mkdirSync(join(lock, "tree"), { recursive: true });
		chmodSync(lock, 0o000);
		locked.push(lock);
		const pi = piOpening(join(lock, "tree"));
		const opened = openStanding(pi.sessions, "/log.jsonl", root);

		expect(opened.left).toBeUndefined();
		expect(pi.calls).toHaveLength(1);
	});

	it("opens its log once, as pi does, when its folder stands", () => {
		const root = scratch();
		const pi = piOpening(root);
		const opened = openStanding(pi.sessions, "/log.jsonl");

		expect(opened.left).toBeUndefined();
		expect(pi.calls).toEqual([["/log.jsonl", undefined, undefined]]);
	});

	it("opens its log again in the folder that stands, naming the one it left", () => {
		const root = scratch();
		const gone = join(root, "tree");
		const pi = piOpening(gone);
		const opened = openStanding(pi.sessions, "/log.jsonl", scratch());

		expect(opened.left).toBe(gone);
		expect(opened.manager.getCwd()).toBe(root);
		expect(pi.calls.at(-1)).toEqual(["/log.jsonl", undefined, root]);
	});

	it("opens its log once, in the folder that stands, when its header names a gone one", () => {
		const root = scratch();
		const gone = join(root, "tree");
		const file = logNaming(root, gone);
		const pi = piOpening(gone);
		const opened = openStanding(pi.sessions, file, scratch());

		expect(opened.left).toBe(gone);
		expect(opened.manager.getCwd()).toBe(root);
		expect(pi.calls).toEqual([[file, undefined, root]]);
	});

	it("opens its log once, as pi does, when its header names a folder that stands", () => {
		const root = scratch();
		const file = logNaming(root, root);
		const pi = piOpening(root);
		const opened = openStanding(pi.sessions, file);

		expect(opened.left).toBeUndefined();
		expect(pi.calls).toEqual([[file, undefined, undefined]]);
	});

	it("leaves a header naming no folder, or an empty one, to pi's open to fill in", () => {
		for (const cwd of [undefined, ""]) {
			const root = scratch();
			const file = logNaming(root, cwd);
			const pi = piOpening(root);
			const opened = openStanding(pi.sessions, file);

			expect(opened.left, `a header naming ${cwd}`).toBeUndefined();
			expect(pi.calls, `a header naming ${cwd}`).toEqual([
				[file, undefined, undefined],
			]);
		}
	});

	it("reads the folder from pi's open when its first line isn't a session header", () => {
		const root = scratch();
		const gone = join(root, "tree");
		const file = join(root, "log.jsonl");
		writeFileSync(
			file,
			`\n${JSON.stringify({ type: "session", id: "s1", cwd: gone })}\n`,
		);
		const pi = piOpening(gone);
		const opened = openStanding(pi.sessions, file, scratch());

		expect(opened.left).toBe(gone);
		expect(pi.calls).toEqual([
			[file, undefined, undefined],
			[file, undefined, root],
		]);
	});

	it("is told of a move once, by the newest word of a move in its log", () => {
		const said = (left: string, now: string) => ({
			type: "custom_message",
			customType: FOLDER_GONE_TYPE,
			details: { left, now },
		});
		const other = { type: "custom_message", customType: "other" };

		expect(toldOfMove([], "/a", "/"), "no word of a move is no move told").toBe(
			false,
		);
		expect(
			toldOfMove([said("/a", "/"), other], "/a", "/"),
			"the newest word of the move is told",
		).toBe(true);
		expect(
			toldOfMove([said("/a", "/"), said("/b", "/")], "/a", "/"),
			"a later move is the one it knows",
		).toBe(false);
		expect(toldOfMove([said("/a", "/h")], "/a", "/"), "now elsewhere").toBe(
			false,
		);
	});
});
