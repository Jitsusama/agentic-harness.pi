/**
 * The strict profile lets a command read nothing of the person's but
 * settings, write only its work and its own folders, and reach no socket
 * but name lookups and Nix's door for sandboxes.
 */

import { describe, expect, it } from "vitest";
import {
	NIX_DOOR,
	strictRules,
} from "../../../../lib/internal/sandbox/strict-rules.ts";

describe("the strict profile", () => {
	const rules = strictRules({
		home: "/home/someone",
		runtimeDir: "/run/user/1000",
		cwd: "/home/someone/src/thing",
	});
	const paths = (flag: string) =>
		rules.filter(([given]) => given === flag).map(([, path]) => path);

	it("lets nothing in the home folder be read but settings, the work and its own cache", () => {
		const home = [...paths("--ro"), ...paths("--rox"), ...paths("--rw")]
			.filter((path) => path.startsWith("/home/someone"))
			.sort();
		expect(home, "the home folder's reachable paths").toEqual(
			[
				"/home/someone/.cache/pi-sandbox/cache",
				"/home/someone/.cache/pi-sandbox/gcloud",
				"/home/someone/.cache/pi-sandbox/tmp",
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

	it("lets a worktree's repository be read and never written", () => {
		const given = strictRules({
			home: "/home/someone",
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
			"TMPDIR=/home/someone/.cache/pi-sandbox/tmp",
			"XDG_CACHE_HOME=/home/someone/.cache/pi-sandbox/cache",
			`NIX_REMOTE=unix:///run/user/1000/${NIX_DOOR}`,
		]);
	});
});
