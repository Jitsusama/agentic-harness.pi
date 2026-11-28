import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type FolderDisk,
	makeSandboxFolders,
} from "../../../../lib/internal/sandbox/sandbox-folders.ts";
import {
	processFolderName,
	temporaryFolders,
} from "../../../../lib/internal/sandbox/strict-rules.ts";

/** Makes `folder` with `file` in it. */
function left(folder: string, file: string): string {
	mkdirSync(folder, { recursive: true });
	const path = join(folder, file);
	writeFileSync(path, "left behind");
	return path;
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

	it("names it by the pid namespace too, where Linux has one, since fenced pids start again at 1", () => {
		let namespace: string | undefined;
		try {
			namespace = /\d+/.exec(readlinkSync("/proc/self/ns/pid"))?.[0];
		} catch {
			// No /proc, as on a Mac: the pid alone.
		}
		expect(processFolderName()).toBe(
			namespace === undefined
				? `pid-${process.pid}`
				: `pid-${namespace}-${process.pid}`,
		);
	});

	it("empties the folder a process names by its pid the first time", () => {
		const own = join(every, processFolderName());
		const earlier = left(own, "planted");
		expect(makeSandboxFolders(home, {})).toBeUndefined();
		expect(existsSync(own), "the folder is made").toBe(true);
		expect(existsSync(earlier), "an earlier process's file").toBe(false);
	});

	it("empties it once a process, keeping what its own commands wrote", () => {
		makeSandboxFolders(home, {});
		const written = left(join(every, processFolderName()), "ours");
		makeSandboxFolders(home, {});
		expect(existsSync(written)).toBe(true);
	});

	it("empties it once a process, not once a copy of the module, as each extension and reload loads", async () => {
		makeSandboxFolders(home, {});
		const written = left(join(every, processFolderName()), "ours");
		vi.resetModules();
		const copy = await import(
			"../../../../lib/internal/sandbox/sandbox-folders.ts"
		);
		expect(copy.makeSandboxFolders).not.toBe(makeSandboxFolders);
		expect(copy.makeSandboxFolders(home, {})).toBeUndefined();
		expect(existsSync(written)).toBe(true);
	});

	it("keeps a session's folder as it was, for a session resumed", () => {
		const kept = left(join(every, "0a1b-session"), "resumed");
		makeSandboxFolders(home, { PI_SESSION_ID: "0a1b-session" });
		expect(existsSync(kept)).toBe(true);
	});

	it("refuses a link in its place, emptying nothing where it leads", () => {
		const theirs = left(elsewhere, "theirs");
		symlinkSync(elsewhere, join(every, processFolderName()));
		expect(makeSandboxFolders(home, {})).toMatch(
			/is a link or not a folder, so no command runs/,
		);
		expect(existsSync(theirs), "what the link leads to").toBe(true);
	});

	it("refuses when it can't be emptied, naming the remedy, and walks it again only once it is gone", () => {
		let there = true;
		let walks = 0;
		const disk: FolderDisk = {
			make: () => {
				there = true;
			},
			look: () =>
				there ? { folder: true, uid: 1000, mode: 0o700 } : undefined,
			narrow: () => undefined,
			empty: () => {
				walks += 1;
				throw new Error("no trusted rm");
			},
			uid: 1000,
		};
		const stuck = join(home, "stuck");
		const refusal = makeSandboxFolders(stuck, {}, disk);
		expect(refusal).toMatch(
			/couldn't empty its folder .*pid-[\d-]+.*no trusted rm.*so no command runs: remove it by hand and try again/,
		);
		expect(makeSandboxFolders(stuck, {}, disk), "the next command").toBe(
			refusal,
		);
		expect(walks, "walked once").toBe(1);
		there = false;
		expect(
			makeSandboxFolders(stuck, {}, disk),
			"once removed by hand",
		).toBeUndefined();
		expect(walks, "made anew, not emptied").toBe(1);
	});

	it("checks the folder again once emptied, refusing a link put there meanwhile", () => {
		const own = join(
			home,
			"swapped",
			".cache/pi-sandbox/tmp",
			processFolderName(),
		);
		let emptied = false;
		const disk: FolderDisk = {
			make: () => undefined,
			look: (folder) => ({
				folder: !(emptied && folder === own),
				uid: 1000,
				mode: 0o700,
			}),
			narrow: () => undefined,
			empty: () => {
				emptied = true;
			},
			uid: 1000,
		};
		expect(makeSandboxFolders(join(home, "swapped"), {}, disk)).toMatch(
			/pid-[\d-]+ is a link or not a folder, so no command runs/,
		);
	});

	it("keeps the folder it was handed in TMPDIR, however the path ends", () => {
		const own = join(every, processFolderName());
		const handed = left(own, "in use");
		for (const handedDown of [own, `${own}/`]) {
			expect(makeSandboxFolders(home, { TMPDIR: handedDown })).toBeUndefined();
			expect(existsSync(handed), handedDown).toBe(true);
		}
	});

	it("empties an earlier process's folder even where it made a folder read-only", () => {
		const own = join(every, processFolderName());
		const locked = join(own, "locked");
		left(locked, "kept");
		chmodSync(locked, 0o500);
		try {
			expect(makeSandboxFolders(home, {})).toBeUndefined();
			expect(existsSync(locked)).toBe(false);
		} finally {
			if (existsSync(locked)) chmodSync(locked, 0o700);
		}
	});
});
