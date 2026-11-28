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

	it("reads the class of the first walk, whose turn the whole command waits", () => {
		expect(
			pushClassOf(
				"WORLD_PUSH_CLASS=0 git fetch origin main && git push",
				inWorld,
			),
		).toBe(0);
		expect(
			pushClassOf(
				"git fetch origin main && WORLD_PUSH_CLASS=0 git push",
				inWorld,
			),
		).toBe(2);
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
