import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lutimesSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type FolderDisk,
	makeSandboxFolders,
	sweepGoneSessions,
} from "../../../../lib/internal/sandbox/sandbox-folders.ts";
import { temporaryFolders } from "../../../../lib/internal/sandbox/strict-rules.ts";

/** A week and a day, in milliseconds: past the sweep's bound. */
const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;

/** Makes `folder` with `file` in it, both last changed at `when`. */
function left(folder: string, file: string, when = Date.now()): string {
	mkdirSync(folder, { recursive: true });
	const path = join(folder, file);
	writeFileSync(path, "left behind");
	ageTo(path, when);
	ageTo(folder, when);
	return path;
}

/** Sets `path`'s times to `when`, not following a link. */
function ageTo(path: string, when: number): void {
	const seconds = when / 1000;
	lutimesSync(path, seconds, seconds);
}

/** A pid no process holds now: a child's, once it has ended. */
function endedPid(): number {
	const ended = spawnSync("true");
	if (ended.pid === undefined) throw new Error("no child to take a pid from");
	return ended.pid;
}

const SESSION = { PI_SESSION_ID: "0a1b-session" };

describe("the strict sandbox's own folders", () => {
	let home: string;
	let elsewhere: string;
	const tmp = () => join(home, ".cache/pi-sandbox/tmp/0a1b-session");

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "sandbox-folders-"));
		elsewhere = mkdtempSync(join(tmpdir(), "sandbox-folders-elsewhere-"));
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(elsewhere, { recursive: true, force: true });
	});

	it("makes each folder, private to this account", () => {
		expect(makeSandboxFolders(home, SESSION)).toBeUndefined();
		for (const folder of ["cache", "gcloud", "tmp/0a1b-session"]) {
			const made = statSync(join(home, ".cache/pi-sandbox", folder));
			expect(made.isDirectory(), folder).toBe(true);
			expect(made.mode & 0o777, folder).toBe(0o700);
		}
	});

	it("refuses a session's temporary folder that is a link, granting nothing where it leads", () => {
		mkdirSync(join(home, ".cache/pi-sandbox/tmp"), { recursive: true });
		symlinkSync(elsewhere, tmp());
		expect(makeSandboxFolders(home, SESSION)).toMatch(
			/0a1b-session is a link or not a folder, so no command runs/,
		);
	});

	it("refuses a file where a folder goes", () => {
		mkdirSync(join(home, ".cache/pi-sandbox"), { recursive: true });
		writeFileSync(join(home, ".cache/pi-sandbox/gcloud"), "");
		expect(makeSandboxFolders(home, SESSION)).toMatch(
			/pi-sandbox\/gcloud.*so no command runs/,
		);
	});

	it("narrows a folder others may reach to this account's alone", () => {
		mkdirSync(join(home, ".cache/pi-sandbox/cache"), { recursive: true });
		chmodSync(join(home, ".cache/pi-sandbox/cache"), 0o777);
		expect(makeSandboxFolders(home, SESSION)).toBeUndefined();
		const cache = statSync(join(home, ".cache/pi-sandbox/cache"));
		expect(cache.mode & 0o777).toBe(0o700);
	});

	it("refuses another account's folder", () => {
		const disk: FolderDisk = {
			make: () => undefined,
			look: () => ({ folder: true, uid: 4242, mode: 0o700 }),
			narrow: () => undefined,
			empty: () => undefined,
			uid: 1000,
		};
		expect(makeSandboxFolders(home, SESSION, disk)).toMatch(
			/belongs to another account, so no command runs/,
		);
	});

	it("refuses, rather than throwing, when a folder can't be made, as in a strict pi whose TMPDIR moved", () => {
		const disk: FolderDisk = {
			make: () => {
				throw new Error("EACCES: permission denied");
			},
			look: () => undefined,
			narrow: () => undefined,
			empty: () => undefined,
			uid: 1000,
		};
		expect(makeSandboxFolders(home, SESSION, disk)).toMatch(
			/couldn't make its folder .* \(Error: EACCES: permission denied\), so no command runs/,
		);
	});
});

describe("a temporary folder named for a process", () => {
	let home: string;
	let every: string;
	let elsewhere: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "sandbox-folders-pid-"));
		elsewhere = mkdtempSync(join(tmpdir(), "sandbox-folders-elsewhere-"));
		every = temporaryFolders(home);
		mkdirSync(every, { recursive: true });
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(elsewhere, { recursive: true, force: true });
	});

	it("empties the folder a process names by its pid the first time", () => {
		const own = join(every, `pid-${process.pid}`);
		const earlier = left(own, "planted");
		expect(makeSandboxFolders(home, {})).toBeUndefined();
		expect(existsSync(own), "the folder is made").toBe(true);
		expect(existsSync(earlier), "an earlier process's file").toBe(false);
	});

	it("empties it once a process, keeping what its own commands wrote", () => {
		makeSandboxFolders(home, {});
		const written = left(join(every, `pid-${process.pid}`), "ours");
		makeSandboxFolders(home, {});
		expect(existsSync(written)).toBe(true);
	});

	it("keeps a session's folder as it was, for a session resumed", () => {
		const kept = left(join(every, "0a1b-session"), "resumed");
		makeSandboxFolders(home, { PI_SESSION_ID: "0a1b-session" });
		expect(existsSync(kept)).toBe(true);
	});

	it("refuses a link in its place, emptying nothing where it leads", () => {
		const theirs = left(elsewhere, "theirs");
		symlinkSync(elsewhere, join(every, `pid-${process.pid}`));
		expect(makeSandboxFolders(home, {})).toMatch(
			/is a link or not a folder, so no command runs/,
		);
		expect(existsSync(theirs), "what the link leads to").toBe(true);
	});

	it("refuses when it can't be emptied", () => {
		const disk: FolderDisk = {
			make: () => undefined,
			look: () => ({ folder: true, uid: 1000, mode: 0o700 }),
			narrow: () => undefined,
			empty: () => {
				throw new Error("no trusted rm");
			},
			uid: 1000,
		};
		expect(makeSandboxFolders(join(home, "fresh"), {}, disk)).toMatch(
			/couldn't empty its folder .*pid-\d+.*no trusted rm.*so no command runs/,
		);
	});
});

describe("sweeping the folders of sessions gone", () => {
	let home: string;
	let every: string;
	const longAgo = () => Date.now() - EIGHT_DAYS_MS;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "sandbox-folders-sweep-"));
		every = temporaryFolders(home);
		mkdirSync(every, { recursive: true });
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("removes a pid's folder once no process holds the pid", async () => {
		const gone = join(every, `pid-${endedPid()}`);
		left(gone, "file");
		expect(await sweepGoneSessions(home, {})).toEqual([gone]);
		expect(existsSync(gone)).toBe(false);
	});

	it("keeps a pid's folder while its process lives, however old", async () => {
		const live = join(every, `pid-${process.ppid}`);
		left(live, "file", longAgo());
		expect(await sweepGoneSessions(home, {})).toEqual([]);
		expect(existsSync(live)).toBe(true);
	});

	it("removes a session's folder once nothing in it changed for a week", async () => {
		const stale = join(every, "9z8y-other");
		left(join(stale, "deep"), "file", longAgo());
		ageTo(stale, longAgo());
		expect(await sweepGoneSessions(home, {})).toEqual([stale]);
		expect(existsSync(stale)).toBe(false);
	});

	it("keeps a session's folder when anything deep in it changed this week", async () => {
		const live = join(every, "9z8y-other");
		left(join(live, "deep"), "file");
		ageTo(join(live, "deep"), longAgo());
		ageTo(live, longAgo());
		expect(await sweepGoneSessions(home, {})).toEqual([]);
		expect(existsSync(live)).toBe(true);
	});

	it("keeps this session's own folder and the one it was handed, however old", async () => {
		const own = join(every, "0a1b-session");
		const handed = join(every, "5c6d-parent");
		left(own, "file", longAgo());
		left(handed, "file", longAgo());
		const swept = await sweepGoneSessions(home, {
			PI_SESSION_ID: "0a1b-session",
			TMPDIR: handed,
		});
		expect(swept).toEqual([]);
		expect(existsSync(own) && existsSync(handed)).toBe(true);
	});

	it("never follows a link, in a folder it removes or in place of one", async () => {
		const outside = mkdtempSync(join(tmpdir(), "sandbox-folders-outside-"));
		try {
			const kept = left(outside, "theirs", longAgo());
			const stale = join(every, "9z8y-other");
			left(stale, "file", longAgo());
			symlinkSync(outside, join(stale, "away"));
			ageTo(join(stale, "away"), longAgo());
			ageTo(stale, longAgo());
			const linked = join(every, `pid-${endedPid()}`);
			symlinkSync(outside, linked);
			expect(await sweepGoneSessions(home, {})).toEqual([stale]);
			expect(existsSync(kept), "what the links lead to").toBe(true);
			expect(existsSync(linked), "a link in a folder's place").toBe(true);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("leaves what no session's folder is named for", async () => {
		const strange = join(every, "not.a.session");
		left(strange, "file", longAgo());
		writeFileSync(join(every, "pid-file"), "a file, not a folder");
		expect(await sweepGoneSessions(home, {})).toEqual([]);
		expect(existsSync(strange)).toBe(true);
	});

	it("sweeps nothing where there is no folder yet", async () => {
		rmSync(every, { recursive: true });
		expect(await sweepGoneSessions(home, {})).toEqual([]);
	});
});
