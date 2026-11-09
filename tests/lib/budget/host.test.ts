import { describe, expect, it } from "vitest";
import { hostBudgets } from "../../../lib/budget/host.ts";
import {
	BUDGET_READY,
	BUDGET_REGISTER_PROVIDER,
	BUDGET_REQUEST,
	type BudgetAnswer,
	type BudgetProvider,
	registerBudgetProvider,
} from "../../../lib/budget/provider.ts";

/** A bus as pi's: handlers by channel, called in order. */
function bus() {
	const handlers = new Map<string, ((data: unknown) => void)[]>();
	return {
		on(channel: string, handler: (data: unknown) => void) {
			handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
			return () => {};
		},
		emit(channel: string, data?: unknown) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
	};
}

function provider(
	id: string,
	precedence: number,
	answers: Record<string, BudgetAnswer>,
): BudgetProvider {
	return {
		id,
		precedence,
		resolve: async (name) => answers[name] ?? { kind: "unknown" },
	};
}

const drawn = (key: string): BudgetAnswer => ({
	kind: "drawn",
	env: { KEY: key },
	label: key,
});

describe("the budget host", () => {
	it("asks providers lowest precedence first, and the first that knows answers", async () => {
		const events = bus();
		const host = hostBudgets(events);
		registerBudgetProvider(
			events,
			provider("company", 10, { delta: drawn("company") }),
		);
		registerBudgetProvider(
			events,
			provider("files", 0, { delta: drawn("mine") }),
		);

		expect(host.listProviders()).toEqual(["files", "company"]);
		expect(await host.draw("delta")).toEqual({
			kind: "drawn",
			provider: "files",
			env: { KEY: "mine" },
			label: "mine",
		});
	});

	it("passes a name a provider does not know to the next", async () => {
		const events = bus();
		const host = hostBudgets(events);
		registerBudgetProvider(events, provider("files", 0, {}));
		registerBudgetProvider(
			events,
			provider("company", 10, { delta: drawn("company") }),
		);

		const drawing = await host.draw("delta");

		expect(drawing.kind === "drawn" && drawing.provider).toBe("company");
	});

	it("stops at a provider that knows the name but can't draw on it", async () => {
		const events = bus();
		const host = hostBudgets(events);
		registerBudgetProvider(
			events,
			provider("company", 0, {
				delta: { kind: "unavailable", reason: "Save the token first." },
			}),
		);
		registerBudgetProvider(
			events,
			provider("files", 10, { delta: drawn("x") }),
		);

		expect(await host.draw("delta")).toEqual({
			kind: "unavailable",
			provider: "company",
			reason: "Save the token first.",
		});
	});

	it("reads a provider that rejects as unavailable, with its reason", async () => {
		const events = bus();
		const host = hostBudgets(events);
		host.registerProvider({
			id: "broken",
			precedence: 0,
			resolve: () => Promise.reject(new Error("disk on fire")),
		});

		expect(await host.draw("delta")).toEqual({
			kind: "unavailable",
			provider: "broken",
			reason: "disk on fire",
		});
	});

	it("reads a provider that doesn't answer in time as unavailable", async () => {
		const events = bus();
		const host = hostBudgets(events, 20);
		host.registerProvider({
			id: "stuck",
			precedence: 0,
			resolve: () => new Promise(() => {}),
		});

		expect(await host.draw("delta")).toEqual({
			kind: "unavailable",
			provider: "stuck",
			reason: "stuck didn't answer within 0.02 s.",
		});
	});

	it("says which it asked when none knows the name", async () => {
		const events = bus();
		const host = hostBudgets(events);
		registerBudgetProvider(events, provider("files", 0, {}));

		expect(await host.draw("delta")).toEqual({
			kind: "unknown",
			asked: ["files"],
		});
	});

	it("takes a provider that registered before it was up, once it announces itself", async () => {
		const events = bus();
		registerBudgetProvider(events, provider("early", 0, { delta: drawn("e") }));

		const host = hostBudgets(events);

		expect(host.listProviders()).toEqual(["early"]);
	});

	it("announces itself again when asked, and ignores a payload that is no provider", () => {
		const events = bus();
		const host = hostBudgets(events);
		let announced = 0;
		events.on(BUDGET_READY, () => {
			announced += 1;
		});

		events.emit(BUDGET_REQUEST);
		events.emit(BUDGET_REGISTER_PROVIDER, { id: "half" });

		expect(announced).toBe(1);
		expect(host.listProviders()).toEqual([]);
	});

	it("tells a listener each time a provider registers", () => {
		const events = bus();
		const host = hostBudgets(events);
		let told = 0;
		host.onRegistered(() => {
			told += 1;
		});

		registerBudgetProvider(events, provider("late", 0, {}));

		expect(told).toBe(1);
	});
});
