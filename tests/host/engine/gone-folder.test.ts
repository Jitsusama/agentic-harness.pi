/**
 * Where a conversation opens when its log's folder is gone: the nearest
 * folder above that stands, or home, said to it once.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
afterEach(() => {
	for (const folder of folders.splice(0))
		rmSync(folder, { recursive: true, force: true });
});

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
		expect(standingFolder("/no-such-folder-here/tree", "/home/x")).toBe(
			"/home/x",
		);
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
		const opened = openStanding(pi.sessions, "/log.jsonl", "/home/x");

		expect(opened.left).toBe(gone);
		expect(opened.manager.getCwd()).toBe(root);
		expect(pi.calls.at(-1)).toEqual(["/log.jsonl", undefined, root]);
	});

	it("is told of a move once, by the newest word of a move in its log", () => {
		const said = (left: string, now: string) => ({
			type: "custom_message",
			customType: FOLDER_GONE_TYPE,
			details: { left, now },
		});
		const other = { type: "custom_message", customType: "other" };

		expect(toldOfMove([], "/a", "/")).toBe(false);
		expect(toldOfMove([said("/a", "/"), other], "/a", "/")).toBe(true);
		expect(
			toldOfMove([said("/a", "/"), said("/b", "/")], "/a", "/"),
			"a later move is the one it knows",
		).toBe(false);
		expect(toldOfMove([said("/a", "/h")], "/a", "/"), "now elsewhere").toBe(
			false,
		);
	});
});
