import { describe, expect, it } from "vitest";
import {
	emptyOverlay,
	layBudget,
	liftBudget,
	withoutBudget,
} from "../../../lib/budget/environment";

const delta = { name: "delta", label: "delta", env: { KEY: "team" } };

describe("a budget laid over an environment", () => {
	it("sets its variables, and lifting it puts back the value it replaced", () => {
		const env: NodeJS.ProcessEnv = { KEY: "personal", OTHER: "kept" };
		const overlay = emptyOverlay();

		layBudget(env, delta, overlay);
		expect(env.KEY).toBe("team");

		liftBudget(env, overlay);
		expect(env).toEqual({ KEY: "personal", OTHER: "kept" });
	});

	it("removes on lifting a variable that was not set before", () => {
		const env: NodeJS.ProcessEnv = {};
		const overlay = emptyOverlay();

		layBudget(env, delta, overlay);
		liftBudget(env, overlay);

		expect("KEY" in env, "an unset variable is unset again").toBe(false);
	});

	it("replacing one budget with another keeps the person's value to put back", () => {
		const env: NodeJS.ProcessEnv = { KEY: "personal" };
		const overlay = emptyOverlay();

		layBudget(env, delta, overlay);
		layBudget(
			env,
			{ name: "aquifer", label: "aquifer", env: { KEY: "aquifer" } },
			overlay,
		);
		expect(env.KEY).toBe("aquifer");

		liftBudget(env, overlay);
		expect(env.KEY, "not delta's value: the person's").toBe("personal");
	});

	it("puts back what the earlier budget set that the next one does not", () => {
		const env: NodeJS.ProcessEnv = {};
		const overlay = emptyOverlay();

		layBudget(
			env,
			{ name: "a", label: "a", env: { KEY: "a", EXTRA: "a" } },
			overlay,
		);
		layBudget(env, { name: "b", label: "b", env: { KEY: "b" } }, overlay);

		expect(env).toEqual({ KEY: "b" });
	});

	it("leaves a value something else changed while the budget was on", () => {
		const env: NodeJS.ProcessEnv = { KEY: "personal" };
		const overlay = emptyOverlay();
		layBudget(env, delta, overlay);

		env.KEY = "refreshed";
		liftBudget(env, overlay);

		expect(env.KEY, "the newer value stands").toBe("refreshed");
	});

	it("laid again on a reload, still knows the person's value", () => {
		const env: NodeJS.ProcessEnv = { KEY: "personal" };
		const overlay = emptyOverlay();

		layBudget(env, delta, overlay);
		layBudget(env, delta, overlay);
		liftBudget(env, overlay);

		expect(env.KEY).toBe("personal");
	});
});

describe("the environment without a budget", () => {
	it("is a copy as it was before the budget, the live one untouched", () => {
		const env: NodeJS.ProcessEnv = { KEY: "personal", PATH: "/bin" };
		const overlay = emptyOverlay();
		layBudget(
			env,
			{ name: "d", label: "d", env: { KEY: "team", ADDED: "x" } },
			overlay,
		);

		expect(withoutBudget(env, overlay)).toEqual({
			KEY: "personal",
			PATH: "/bin",
		});
		expect(env.KEY).toBe("team");
	});
});
