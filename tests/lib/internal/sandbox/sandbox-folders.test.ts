import {
	chmodSync,
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
} from "../../../../lib/internal/sandbox/sandbox-folders.ts";

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
			uid: 1000,
		};
		expect(makeSandboxFolders(home, SESSION, disk)).toMatch(
			/couldn't make its folder .* \(Error: EACCES: permission denied\), so no command runs/,
		);
	});
});
