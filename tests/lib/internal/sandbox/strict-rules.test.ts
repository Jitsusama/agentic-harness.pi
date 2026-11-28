/**
 * The strict profile lets a command read nothing of the person's but
 * settings, write only its work and its own folders, and reach no socket
 * but name lookups and Nix's door for sandboxes. It runs what it built
 * only in its work and its temporary folder, where a build runs what it
 * builds, and that folder is its session's own, so no session runs what
 * another planted.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	fileReach,
	NIX_DOOR,
	processFolderName,
	STRICT_TMPDIR,
	strictRules,
} from "../../../../lib/internal/sandbox/strict-rules.ts";

/** The session these cases run in, and the temporary folder it is given. */
const SESSION = { PI_SESSION_ID: "0a1b-session" };
const TEMPORARY = "/home/someone/.cache/pi-sandbox/tmp/0a1b-session";

describe("the strict profile", () => {
	const rules = strictRules({
		home: "/home/someone",
		env: SESSION,
		runtimeDir: "/run/user/1000",
		cwd: "/home/someone/src/thing",
	});
	const paths = (flag: string) =>
		rules.filter(([given]) => given === flag).map(([, path]) => path);

	it("lets nothing in the home folder be read but settings, the work and its own cache", () => {
		const home = [
			...paths("--ro"),
			...paths("--rox"),
			...paths("--rwx"),
			...paths("--rw"),
		]
			.filter((path) => path.startsWith("/home/someone"))
			.sort();
		expect(home, "the home folder's reachable paths").toEqual(
			[
				"/home/someone/.cache/pi-sandbox/cache",
				"/home/someone/.cache/pi-sandbox/gcloud",
				TEMPORARY,
				"/home/someone/.config/dev",
				"/home/someone/.config/git",
				"/home/someone/.config/nix/nix.conf",
				"/home/someone/.gitconfig",
				"/home/someone/.local/state/nix/profile",
				"/home/someone/.nix-profile",
				"/home/someone/src/thing",
			].sort(),
		);
	});

	it("runs what it wrote in its work and its temporary folder", () => {
		const flagsOf = (path: string) =>
			rules.filter(([, given]) => given === path).map(([flag]) => flag);
		expect(flagsOf("/home/someone/src/thing"), "the work").toEqual(["--rwx"]);
		expect(flagsOf(TEMPORARY), "the temporary folder").toEqual(["--rwx"]);
	});

	it("gives each session a temporary folder of its own, and none the one they share", () => {
		const other = strictRules({
			home: "/home/someone",
			env: { PI_SESSION_ID: "9z8y-other" },
			runtimeDir: undefined,
			cwd: "/home/someone/src/thing",
		});
		const reached = (given: readonly (readonly [string, string])[]) =>
			given.map(([, path]) => path);
		expect(reached(other)).toContain(
			"/home/someone/.cache/pi-sandbox/tmp/9z8y-other",
		);
		expect(reached(other)).not.toContain(TEMPORARY);
		expect(reached(rules)).not.toContain("/home/someone/.cache/pi-sandbox/tmp");
		expect(reached(other)).not.toContain("/home/someone/.cache/pi-sandbox/tmp");
	});

	describe("handed a temporary folder by what started it", () => {
		let home: string;
		let every: string;
		/** The folder a command handed `TMPDIR` is given, inside a strict command handed `strict` when one is named. */
		const within = (TMPDIR: string, strict?: string) =>
			strictRules({
				home,
				env: {
					PI_SESSION_ID: "9z8y-inner",
					TMPDIR,
					...(strict === undefined ? {} : { [STRICT_TMPDIR]: strict }),
				},
				runtimeDir: undefined,
				cwd: join(home, "src/thing"),
			}).filter(([flag]) => flag === "--rwx")[1]?.[1];

		beforeEach(() => {
			home = mkdtempSync(join(tmpdir(), "strict-rules-home-"));
			every = join(home, ".cache/pi-sandbox/tmp");
			mkdirSync(join(every, "0a1b-session"), { recursive: true });
		});

		afterEach(() => {
			chmodSync(every, 0o700);
			rmSync(home, { recursive: true, force: true });
		});

		it("keeps its own session's", () => {
			expect(within(join(every, "9z8y-inner"))).toBe(join(every, "9z8y-inner"));
		});

		it("spells a kept one anew, so no trailing slash has the link check follow a link", () => {
			const handed = `${every}/0a1b-session/`;
			expect(within(handed, handed)).toBe(join(every, "0a1b-session"));
		});

		it("takes its own in place of another session's, outside a sandbox", () => {
			expect(
				within(join(every, "0a1b-session")),
				"an unfenced spawner's, naming another session",
			).toBe(join(every, "9z8y-inner"));
		});

		it("keeps the one a strict command already runs in, as its rules name it", () => {
			const handed = join(every, "0a1b-session");
			expect(within(handed, handed), "a strict pi's own command").toBe(handed);
		});

		// The #2460 council's F69: any command could set the shared folder's
		// mode, which a strict command was once known by.
		it("takes its own outside a sandbox, though the folder they share can't be listed", () => {
			chmodSync(every, 0o300);
			expect(within(join(every, "0a1b-session"))).toBe(
				join(every, "9z8y-inner"),
			);
		});

		it("keeps a handed folder only where its strict rules name that same one", () => {
			expect(
				within(join(every, "0a1b-session"), join(every, "7x6w-another")),
			).toBe(join(every, "9z8y-inner"));
		});

		it("keeps none but a session's own folder, sandboxed or not", () => {
			const own = join(every, "9z8y-inner");
			const handed = [
				["/run/user/1000/quest/tmp", "an unfenced session's"],
				[every, "the folder they share"],
				// Spelt as given, not joined, which would take the dots away.
				[`${every}/a/b`, "a folder deeper in it"],
				[`${every}/..`, "the sandbox's own folder"],
				[`${every}/.`, "the folder they share"],
				[`${every}/a b`, "a name no session takes"],
			] as const;
			for (const strict of [false, true]) {
				for (const [folder, what] of handed) {
					expect(within(folder, strict ? folder : undefined), what).toBe(own);
				}
			}
		});
	});

	it("names the folder for the process when the session's id isn't a folder's name", () => {
		for (const PI_SESSION_ID of ["..", "a/b", "", "x".repeat(65)]) {
			const given = strictRules({
				home: "/home/someone",
				env: { PI_SESSION_ID },
				runtimeDir: undefined,
				cwd: "/home/someone/src/thing",
			}).map(([, path]) => path);
			expect(given, JSON.stringify(PI_SESSION_ID)).toContain(
				`/home/someone/.cache/pi-sandbox/tmp/${processFolderName()}`,
			);
		}
	});

	it("writes its cache and gcloud's settings without running anything there", () => {
		for (const path of [
			"/home/someone/.cache/pi-sandbox/cache",
			"/home/someone/.cache/pi-sandbox/gcloud",
		]) {
			const flags = rules
				.filter(([, given]) => given === path)
				.map(([flag]) => flag);
			expect(flags, path).toEqual(["--rw"]);
		}
	});

	it("lets nothing else written be run", () => {
		expect(paths("--rwx"), "the paths written and run").toEqual([
			"/home/someone/src/thing",
			TEMPORARY,
		]);
	});

	it("leaves pi's file tools writing where they did", () => {
		const place = {
			home: "/home/someone",
			env: SESSION,
			runtimeDir: "/run/user/1000",
			cwd: "/home/someone/src/thing",
		};
		expect(fileReach(place, "write")).toEqual([
			"/home/someone/src/thing",
			TEMPORARY,
			"/home/someone/.cache/pi-sandbox/cache",
			"/home/someone/.cache/pi-sandbox/gcloud",
		]);
		expect(fileReach(place, "read")).toEqual(
			expect.arrayContaining(["/home/someone/src/thing", TEMPORARY]),
		);
	});

	it("lets a worktree's repository be read and never written", () => {
		const given = strictRules({
			home: "/home/someone",
			env: SESSION,
			runtimeDir: undefined,
			cwd: "/home/someone/trees/thing",
			repository: "/home/someone/src/thing/.git",
		});
		const flags = given
			.filter(([, path]) => path === "/home/someone/src/thing/.git")
			.map(([flag]) => flag);
		expect(flags, "the repository is read-only").toEqual(["--ro"]);
	});

	it("reaches no socket but name lookups and Nix's door for sandboxes", () => {
		expect(paths("--unix"), "the sockets a command reaches").toEqual([
			"/run/nscd/socket",
			`/run/user/1000/${NIX_DOOR}`,
		]);
		expect(paths("--env"), "the variables the profile sets").toEqual([
			`TMPDIR=${TEMPORARY}`,
			`PI_STRICT_TMPDIR=${TEMPORARY}`,
			"XDG_CACHE_HOME=/home/someone/.cache/pi-sandbox/cache",
			`NIX_REMOTE=unix:///run/user/1000/${NIX_DOOR}`,
		]);
	});
});

describe("the strict profile on a machine that grants more", () => {
	const place = {
		home: "/home/worker",
		runtimeDir: "/run/user/1001",
		cwd: "/home/worker/work",
		env: SESSION,
		grants: {
			read: ["/run/worker-signing"],
			write: ["/world", "/dev/kvm"],
		},
	};
	const rules = strictRules(place);
	const flagsOf = (path: string) =>
		rules.filter(([, given]) => given === path).map(([flag]) => flag);

	it("lets a granted read be read and never written", () => {
		expect(flagsOf("/run/worker-signing"), "a granted read").toEqual(["--ro"]);
	});

	it("lets a granted folder be written and what is built there run", () => {
		expect(flagsOf("/world"), "a granted folder").toEqual(["--rwx"]);
	});

	it("lets a granted device be written and never run", () => {
		expect(flagsOf("/dev/kvm"), "a granted device").toEqual(["--rw"]);
	});

	it("lets pi's file tools reach a granted folder but no granted device", () => {
		const writes = fileReach(place, "write");
		const reads = fileReach(place, "read");
		expect(writes, "file tools write a granted folder").toContain("/world");
		expect(writes, "file tools write no device").not.toContain("/dev/kvm");
		expect(reads, "file tools read a granted read").toContain(
			"/run/worker-signing",
		);
		expect(writes, "file tools never write a granted read").not.toContain(
			"/run/worker-signing",
		);
	});

	it("grants nothing more where the machine grants nothing", () => {
		const plain = strictRules({ ...place, grants: { read: [], write: [] } });
		const bare = strictRules({
			home: place.home,
			runtimeDir: place.runtimeDir,
			cwd: place.cwd,
			env: place.env,
		});
		expect(plain, "an empty grant changes nothing").toEqual(bare);
	});
});
