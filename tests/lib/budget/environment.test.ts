import { describe, expect, it } from "vitest";
import {
	emptyOverlay,
	layBudget,
	liftBudget,
	withoutBudget,
} from "../../../lib/budget/environment.ts";
import { budgetKeysOf } from "../../../lib/budget/index.ts";

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

		expect(env).toEqual({ KEY: "b", PI_BUDGET: "b", PI_BUDGET_KEYS: "KEY" });
	});

	it("names the variables it laid in PI_BUDGET_KEYS, which lifting it takes off", () => {
		const env: NodeJS.ProcessEnv = { KEY: "personal" };
		const overlay = emptyOverlay();

		layBudget(
			env,
			{ name: "delta", label: "Delta", env: { Z_KEY: "t", KEY: "team" } },
			overlay,
		);
		expect(budgetKeysOf(env)).toEqual(["KEY", "Z_KEY"]);

		liftBudget(env, overlay);
		expect("PI_BUDGET_KEYS" in env).toBe(false);
		expect(budgetKeysOf(env)).toEqual([]);
	});

	it("names no keys for a budget that lays none, even after one that did", () => {
		const env: NodeJS.ProcessEnv = {};
		const overlay = emptyOverlay();

		layBudget(env, delta, overlay);
		layBudget(env, { name: "bare", label: "bare", env: {} }, overlay);

		expect(env).toEqual({ PI_BUDGET: "bare", PI_BUDGET_KEYS: "" });
		expect(budgetKeysOf(env)).toEqual([]);
	});

	it("names no keys for a keyless budget over an inherited list, and puts the list back", () => {
		// A session started under delta, whose own quest's budget lays none.
		const env: NodeJS.ProcessEnv = {
			KEY: "team",
			PI_BUDGET: "delta",
			PI_BUDGET_KEYS: "KEY",
		};
		const overlay = emptyOverlay();

		layBudget(env, { name: "bare", label: "bare", env: {} }, overlay);
		expect(budgetKeysOf(env)).toEqual([]);

		liftBudget(env, overlay);
		expect(env).toEqual({
			KEY: "team",
			PI_BUDGET: "delta",
			PI_BUDGET_KEYS: "KEY",
		});
	});

	it("names only the variables it laid, whatever its provider's env says", () => {
		const env: NodeJS.ProcessEnv = {};

		layBudget(
			env,
			{
				name: "delta",
				label: "Delta",
				env: {
					KEY: "team",
					PI_BUDGET: "aquifer",
					PI_BUDGET_KEYS: "OTHER_KEY",
					"A,OTHER_KEY": "x",
				},
			},
			emptyOverlay(),
		);

		expect(env.PI_BUDGET).toBe("delta");
		expect(env.PI_BUDGET_KEYS).toBe("KEY");
		// Laid as the provider gave it, but never named in the list.
		expect(env["A,OTHER_KEY"]).toBe("x");
		expect(budgetKeysOf(env)).toEqual(["KEY"]);
	});

	it("names its keys in a conversation's environment on a shared host", () => {
		const held = new Map<string, string>([["KEY", "host"]]);
		const conversation = {
			get: (key: string) => held.get(key),
			set: (key: string, value: string) => {
				held.set(key, value);
			},
			delete: (key: string) => {
				held.delete(key);
			},
			snapshot: () => Object.fromEntries(held),
		};
		const overlay = emptyOverlay();

		layBudget(conversation, delta, overlay);
		expect(budgetKeysOf(conversation.snapshot())).toEqual(["KEY"]);

		liftBudget(conversation, overlay);
		expect(conversation.snapshot()).toEqual({ KEY: "host" });
	});

	it("leaves PI_BUDGET_KEYS out of a copy made with no budget on", () => {
		const env: NodeJS.ProcessEnv = {};
		const overlay = emptyOverlay();

		layBudget(env, delta, overlay);

		expect(withoutBudget(env, overlay)).toEqual({});
	});

	it("names the budget in PI_BUDGET, and lifting it puts back an inherited one", () => {
		const env: NodeJS.ProcessEnv = { PI_BUDGET: "parent" };
		const overlay = emptyOverlay();

		layBudget(env, delta, overlay);
		expect(env.PI_BUDGET, "what a child started now inherits").toBe("delta");

		liftBudget(env, overlay);
		expect(env.PI_BUDGET, "the budget this process was started on").toBe(
			"parent",
		);
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
