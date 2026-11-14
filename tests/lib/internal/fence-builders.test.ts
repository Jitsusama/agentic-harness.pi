/**
 * The builders' folder inside the fence, through a real bubblewrap: the
 * cloud token never there, even once the lender replaces it while a
 * command runs, and everything else readable but not writable. It skips
 * only where no bubblewrap can make a namespace, as inside another
 * sandbox.
 */

import { spawn, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	fenceArgs,
	fenceRefusesRead,
	fenceRefusesWrite,
} from "../../../lib/internal/fence.ts";
import {
	BUILDERS_FOLDER,
	buildersFolderArgs,
} from "../../../lib/internal/fence-builders.ts";
import { DISK, type Disk } from "../../../lib/internal/fence-disk.ts";

/** A bubblewrap on `PATH` that can make a namespace here, or nothing. */
function workingBwrap(): string | undefined {
	const found = spawnSync("bash", ["-c", "command -v bwrap"], {
		encoding: "utf8",
	}).stdout.trim();
	if (!found) return undefined;
	const tried = spawnSync(found, [
		"--unshare-user",
		"--ro-bind",
		"/",
		"/",
		"true",
	]);
	return tried.status === 0 ? found : undefined;
}

const bwrap = workingBwrap();

describe("the builders' folder in the fence's arguments", () => {
	const disk: Disk = {
		kind: (path) =>
			path === BUILDERS_FOLDER || path.endsWith("/wanted") ? "folder" : "file",
		entries: () => ["machines", "cloud-token", "wanted", "health.json"],
	};

	it("covers it and binds back all but the token, read-only", () => {
		const args = buildersFolderArgs(disk);
		expect(args.slice(0, 2), "the folder isn't covered").toEqual([
			"--tmpfs",
			BUILDERS_FOLDER,
		]);
		expect(args.at(-2), "the cover stays writable").toBe("--remount-ro");
		expect(args.join(" "), "the token was bound").not.toContain("cloud-token");
		for (const name of ["health.json", "machines", "wanted"]) {
			const path = join(BUILDERS_FOLDER, name);
			expect(args.join(" "), `${name} wasn't bound back`).toContain(
				`--ro-bind ${path} ${path}`,
			);
		}
	});

	it("leaves out a machine with no builders' folder", () => {
		const none: Disk = { kind: () => undefined, entries: () => [] };
		expect(buildersFolderArgs(none)).toEqual([]);
	});

	it("refuses pi's file tools the token, and writes anywhere in the folder", () => {
		const place = {
			home: "/home/u",
			cwd: "/home/u/src",
			runtimeDir: undefined,
		};
		expect(
			fenceRefusesRead(join(BUILDERS_FOLDER, "cloud-token"), place, disk),
			"the token was read",
		).toBe(true);
		expect(
			fenceRefusesRead(join(BUILDERS_FOLDER, "health.json"), place, disk),
			"the builders' health was refused",
		).toBe(false);
		expect(
			fenceRefusesWrite(join(BUILDERS_FOLDER, "machines"), place, disk),
			"the builders' list was written",
		).toBe(true);
	});

	it("is part of every fenced command's arguments", () => {
		const args = fenceArgs({ home: "/home/u", runtimeDir: undefined }, disk);
		expect(args.join(" "), "the folder isn't covered").toContain(
			`--tmpfs ${BUILDERS_FOLDER}`,
		);
	});
});

describe.skipIf(bwrap === undefined)(
	"the builders' folder through a real bubblewrap",
	() => {
		let base = "";
		let folder = "";
		let token = "";

		/** The bubblewrap arguments for `script` over the stand-in folder. */
		function argsFor(script: string): string[] {
			return [
				"--unshare-user",
				"--bind",
				"/",
				"/",
				...buildersFolderArgs(DISK, folder),
				"sh",
				"-c",
				script,
			];
		}

		/** Whether `script` succeeds inside. */
		function inside(script: string): boolean {
			return spawnSync(bwrap ?? "bwrap", argsFor(script)).status === 0;
		}

		beforeAll(() => {
			base = mkdtempSync(join(tmpdir(), "fbf-"));
			folder = join(base, "nix-offload");
			mkdirSync(join(folder, "wanted"), { recursive: true });
			token = join(folder, "cloud-token");
			writeFileSync(token, "secret-1");
			writeFileSync(join(folder, "machines"), "builder");
		});

		afterAll(() => rmSync(base, { recursive: true, force: true }));

		it("has no token, and reads the rest", () => {
			expect(inside(`test -e '${token}'`), "the token is there").toBe(false);
			expect(
				inside(`grep -q builder '${folder}/machines'`),
				"the builders' list can't be read",
			).toBe(true);
		});

		it("writes nothing there", () => {
			expect(
				inside(`echo x > '${folder}/machines'`),
				"the builders' list was written",
			).toBe(false);
			expect(inside(`touch '${folder}/planted'`), "something was added").toBe(
				false,
			);
			expect(
				inside(`touch '${folder}/wanted/planted'`),
				"something was added to a folder in it",
			).toBe(false);
			expect(readFileSync(join(folder, "machines"), "utf8")).toBe("builder");
		});

		it("still has no token after the lender replaces it while a command runs", async () => {
			// Waits on its stdin, a pipe the test closes once the token is
			// replaced outside, then looks for it.
			const running = spawn(
				bwrap ?? "bwrap",
				argsFor(`read _; test -e '${token}'`),
				{
					stdio: ["pipe", "ignore", "ignore"],
				},
			);
			const ended = new Promise<number | null>((settle) =>
				running.on("exit", settle),
			);
			// Time for the namespace to be made before the token is replaced.
			await new Promise((settle) => setTimeout(settle, 300));
			const next = `${token}.next`;
			writeFileSync(next, "secret-2");
			renameSync(next, token);
			running.stdin?.end("\n");
			expect(await ended, "the replaced token showed inside").not.toBe(0);
		});
	},
);
