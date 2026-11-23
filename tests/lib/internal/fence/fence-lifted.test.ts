/**
 * The fence lifted from every session but subagents and spawns that
 * declared it, on Linux or on a Mac not known to be outside a sandbox,
 * until it relands.
 */

import { describe, expect, it } from "vitest";
import {
	declaredSandbox,
	liftFence,
} from "../../../../lib/internal/fence/fence-lifted.ts";

describe("the fence lifted until it relands", () => {
	it("takes the fence out of a session's own environment", () => {
		const env: NodeJS.ProcessEnv = { PI_SANDBOX: "fence" };
		expect(liftFence(env), "the fence wasn't lifted").toBe(true);
		expect("PI_SANDBOX" in env, "PI_SANDBOX is still set").toBe(false);
	});

	it("leaves a subagent fenced, by either of its supervisor's marks", () => {
		for (const mark of [
			{ SUBAGENT_SUPERVISOR: "1" },
			{ SUBAGENT_RUN_ID: "run-1" },
		]) {
			const env: NodeJS.ProcessEnv = { PI_SANDBOX: "fence", ...mark };
			expect(liftFence(env), "a subagent's fence was lifted").toBe(false);
			expect(env.PI_SANDBOX, "a subagent lost its fence").toBe("fence");
		}
	});

	it("leaves a spawn that declared the fence fenced on Linux", () => {
		const env: NodeJS.ProcessEnv = { ...declaredSandbox("fence") };
		expect(liftFence(env, "linux"), "a declared fence was lifted").toBe(false);
		expect(env.PI_SANDBOX, "a declared spawn lost its fence").toBe("fence");
	});

	it("lifts a declared fence on a Mac where nothing sandboxes pi, mark and all, since its commands would be refused", () => {
		const env: NodeJS.ProcessEnv = { ...declaredSandbox("fence") };
		expect(
			liftFence(env, "darwin", () => "outside"),
			"the Mac kept a fence with nothing around pi",
		).toBe(true);
		expect(env, "the fence or its mark is still set").toEqual({});
	});

	it("leaves a declared fence on a Mac where pi runs inside some sandbox, so its host is told the fence", () => {
		const env: NodeJS.ProcessEnv = { ...declaredSandbox("fence") };
		expect(
			liftFence(env, "darwin", () => "inside"),
			"a declared fence inside a sandbox was lifted",
		).toBe(false);
		expect(env.PI_SANDBOX, "a declared spawn lost its fence").toBe("fence");
	});

	it("keeps a declared fence on a Mac whose trial couldn't tell, so a later trial decides", () => {
		const env: NodeJS.ProcessEnv = { ...declaredSandbox("fence") };
		expect(
			liftFence(env, "darwin", () => "unknown"),
			"a slow trial lifted a declared fence for good",
		).toBe(false);
		expect(env, "the fence or its mark was taken").toEqual(
			declaredSandbox("fence"),
		);
	});

	it("lifts a fence whose mark says anything but its own value", () => {
		const env: NodeJS.ProcessEnv = {
			PI_SANDBOX: "fence",
			PI_FENCE_DECLARED: "yes",
		};
		expect(liftFence(env, "linux"), "a stray mark kept the fence").toBe(true);
	});

	it("marks only the fence it hands on, since strict is never lifted", () => {
		expect(declaredSandbox("fence"), "the fence goes with its mark").toEqual({
			PI_SANDBOX: "fence",
			PI_FENCE_DECLARED: "1",
		});
		expect(declaredSandbox("strict"), "strict goes alone").toEqual({
			PI_SANDBOX: "strict",
		});
		expect(declaredSandbox(undefined), "no sandbox sets nothing").toEqual({});
	});

	it("never touches strict, or a session with no sandbox", () => {
		const strict: NodeJS.ProcessEnv = { PI_SANDBOX: "strict" };
		expect(liftFence(strict), "strict counted as lifted").toBe(false);
		expect(strict.PI_SANDBOX, "strict was changed").toBe("strict");
		const none: NodeJS.ProcessEnv = {};
		expect(liftFence(none), "nothing counted as lifted").toBe(false);
		expect(none, "an empty environment gained a value").toEqual({});
	});
});
