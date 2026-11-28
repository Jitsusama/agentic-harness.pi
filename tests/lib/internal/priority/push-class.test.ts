import { describe, expect, it } from "vitest";
import {
	isPushClass,
	pushClassOf,
} from "../../../../lib/internal/priority/push-class.ts";

describe("the class a walk of World's objects gives World's push gate", () => {
	const home = "/home/j";
	const inWorld = { cwd: `${home}/world/trees/w-main/src`, home };

	it("reads the class set before the walk's own command", () => {
		// 27 November, 17:24: a class-0 fetch written this way waited
		// 2052 s behind class-1 walks.
		expect(
			pushClassOf("WORLD_PUSH_CLASS=0 git fetch origin main", inWorld),
		).toBe(0);
		expect(pushClassOf('WORLD_PUSH_CLASS="1" git push', inWorld)).toBe(1);
		expect(
			pushClassOf("GIT_TRACE=1 WORLD_PUSH_CLASS=0 git push -q", inWorld),
		).toBe(0);
		expect(
			pushClassOf("env WORLD_PUSH_CLASS=0 git fetch origin main", inWorld),
		).toBe(0);
	});

	it("reads the class given behind what the walk runs under", () => {
		const given = [
			"(WORLD_PUSH_CLASS=0 git push)",
			"( WORLD_PUSH_CLASS=0 git push )",
			"{ WORLD_PUSH_CLASS=0 git push; }",
			"if true; then WORLD_PUSH_CLASS=0 git push; fi",
			"for r in a; do WORLD_PUSH_CLASS=0 git push; done",
			"if false; then true; else WORLD_PUSH_CLASS=0 git push; fi",
			"! WORLD_PUSH_CLASS=0 git push",
			"timeout 600 env WORLD_PUSH_CLASS=0 git push",
			"timeout -k 5 -s KILL 10m env WORLD_PUSH_CLASS=0 git push",
			"timeout --signal=TERM 600 env WORLD_PUSH_CLASS=0 git push",
			"WORLD_PUSH_CLASS=0 timeout 600 git push",
			"nice env WORLD_PUSH_CLASS=0 git push",
			"nice -n 10 env WORLD_PUSH_CLASS=0 git push",
			"nice -5 env WORLD_PUSH_CLASS=0 git push",
			"WORLD_PUSH_CLASS=0 nice -n 19 git push",
			"env -u GIT_TRACE WORLD_PUSH_CLASS=0 git push",
			"env -i HOME=/home/j WORLD_PUSH_CLASS=0 git push",
			"env - WORLD_PUSH_CLASS=0 git push",
			"env -C /home/j/world/src WORLD_PUSH_CLASS=0 git push",
			"command env WORLD_PUSH_CLASS=0 git push",
			"WORLD_PUSH_CLASS=0 command git push",
			"exec env WORLD_PUSH_CLASS=0 git push",
			"WORLD_PUSH_CLASS=0 exec -a push git push",
			"nohup env WORLD_PUSH_CLASS=0 git push",
			"time WORLD_PUSH_CLASS=0 git push",
			"direnv exec . env WORLD_PUSH_CLASS=0 git push",
			"WORLD_PUSH_CLASS=0 direnv exec . git push",
			"WORLD_PUSH_CLASS=0 \\\n  git push",
			"GIT_TRACE=1 \\\n  WORLD_PUSH_CLASS=0 \\\n  timeout 600 \\\n  git push",
		];
		for (const command of given) {
			expect(pushClassOf(command, inWorld), command).toBe(0);
		}
		// Past a program that runs its next word, a variable is that word.
		for (const command of [
			"nice WORLD_PUSH_CLASS=0 git push",
			"timeout 600 WORLD_PUSH_CLASS=0 git push",
			"direnv status && WORLD_PUSH_CLASS=0 true; git push",
		]) {
			expect(pushClassOf(command, inWorld), command).toBe(2);
		}
	});

	it("reads the class exported earlier in the command", () => {
		expect(
			pushClassOf(
				`export WORLD_PUSH_CLASS=1; cd ${home}/world/trees/a/src && git fetch origin main`,
				{ home },
			),
		).toBe(1);
		expect(
			pushClassOf(
				"WORLD_PUSH_CLASS=0\nexport WORLD_PUSH_CLASS\ngit push",
				inWorld,
			),
		).toBe(0);
	});

	it("reads the soonest class of any walk, since the whole command waits one turn", () => {
		expect(
			pushClassOf(
				"WORLD_PUSH_CLASS=0 git fetch origin main && git push",
				inWorld,
			),
		).toBe(0);
		// A dated push chained after a fetch or a rebase waits as its own
		// class, not as the walk ahead of it.
		expect(
			pushClassOf(
				"git fetch origin main && WORLD_PUSH_CLASS=0 git push",
				inWorld,
			),
		).toBe(0);
		expect(
			pushClassOf(
				"WORLD_PUSH_CLASS=1 git rebase origin/main && WORLD_PUSH_CLASS=0 git push -f",
				inWorld,
			),
		).toBe(0);
		expect(
			pushClassOf(
				"WORLD_PUSH_CLASS=2 git fetch origin main; WORLD_PUSH_CLASS=1 git rebase origin/main; git push",
				inWorld,
			),
		).toBe(1);
		// The class exported after one walk reaches the walks after it.
		expect(
			pushClassOf(
				"git fetch origin main; export WORLD_PUSH_CLASS=0; git push",
				inWorld,
			),
		).toBe(0);
	});

	it("reads the class the shell runs with, which the command's own overrides", () => {
		expect(pushClassOf("git fetch origin main", inWorld, "1")).toBe(1);
		expect(
			pushClassOf("WORLD_PUSH_CLASS=0 git fetch origin main", inWorld, "1"),
		).toBe(0);
		expect(
			pushClassOf(
				"unset WORLD_PUSH_CLASS; git fetch origin main",
				inWorld,
				"0",
			),
		).toBe(2);
		// A plain assignment reaches git only once the variable is exported.
		expect(
			pushClassOf("WORLD_PUSH_CLASS=0; git fetch origin main", inWorld, "1"),
		).toBe(0);
		expect(
			pushClassOf("WORLD_PUSH_CLASS=0; git fetch origin main", inWorld),
		).toBe(2);
	});

	it("ranks a walk with no class, or one the gate can't read, as 2", () => {
		expect(pushClassOf("git fetch origin main", inWorld)).toBe(2);
		for (const bad of ["3", "-1", "01", "", "soon", "0.5", "$C"]) {
			expect(
				pushClassOf(`WORLD_PUSH_CLASS=${bad} git fetch origin main`, inWorld),
				bad,
			).toBe(2);
			expect(pushClassOf("git push", inWorld, bad), bad).toBe(2);
		}
		// Set for another command, it never reaches the walk.
		expect(
			pushClassOf("WORLD_PUSH_CLASS=0 true; git fetch origin main", inWorld),
		).toBe(2);
		// A walk of another repository carries nothing to World's gate.
		expect(
			pushClassOf("WORLD_PUSH_CLASS=0 git fetch", {
				cwd: `${home}/src/core.nix`,
				home,
			}),
		).toBe(2);
	});

	it("knows only 0, 1 and 2 as classes", () => {
		for (const good of [0, 1, 2]) {
			expect(isPushClass(good), String(good)).toBe(true);
		}
		for (const bad of [3, -1, "0", 0.5, undefined, null]) {
			expect(isPushClass(bad), String(bad)).toBe(false);
		}
	});
});
