/**
 * The fence lifted from every session but subagents, until it relands.
 */

import { describe, expect, it } from "vitest";
import { liftFence } from "../../../lib/internal/fence-lifted.ts";

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

	it("never touches strict, or a session with no sandbox", () => {
		const strict: NodeJS.ProcessEnv = { PI_SANDBOX: "strict" };
		expect(liftFence(strict), "strict counted as lifted").toBe(false);
		expect(strict.PI_SANDBOX, "strict was changed").toBe("strict");
		const none: NodeJS.ProcessEnv = {};
		expect(liftFence(none), "nothing counted as lifted").toBe(false);
		expect(none, "an empty environment gained a value").toEqual({});
	});
});
