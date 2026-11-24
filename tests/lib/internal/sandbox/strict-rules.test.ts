/**
 * The strict profile lets a command read nothing of the person's but
 * settings, write only its work and its own folders, and reach no socket
 * but name lookups and Nix's door for sandboxes. What nix-offload needs
 * of the builders, a command is given and pi's own tools are not.
 */

import { describe, expect, it } from "vitest";
import {
	fileReach,
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

	it("gives a command what nix-offload needs of the builders, and pi's own tools none of it", () => {
		const place = {
			home: "/home/someone",
			runtimeDir: undefined,
			cwd: "/home/someone/src/thing",
			builders: {
				readable: ["/run/nix-offload-lines", "/run/nix-offload"],
				writable: [
					"/run/offload-wants",
					"/home/someone/.local/state/nix-offload",
				],
			},
		};
		const given = strictRules(place);
		const flagOf = (path: string) =>
			given.filter(([, one]) => one === path).map(([flag]) => flag);
		expect(flagOf("/run/nix-offload"), "a lender's folder").toEqual(["--ro"]);
		expect(flagOf("/run/offload-wants"), "the wants").toEqual(["--rw"]);
		const tools = [...fileReach(place, "read"), ...fileReach(place, "write")];
		for (const path of [
			...place.builders.readable,
			...place.builders.writable,
		]) {
			expect(tools, "pi's own tools reach the builders").not.toContain(path);
		}
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
