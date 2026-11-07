/**
 * The budget item as pi drives it: told at start from spend-watch,
 * moved by Claude Code's word after a turn and by the quest settling
 * its budget, and quiet in a session with no person at it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerBudgetItem } from "../../../extensions/spend-workflow/budget-item.ts";
import { BUDGET_SETTLED } from "../../../lib/budget/record.ts";
import type { Exec } from "../../../lib/core/exec/index.ts";
import { RATE_LIMIT } from "../../../lib/internal/claude-plan.ts";
import { FOOTER_GLYPH } from "../../../lib/ui/footer-mark.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

/** spend-watch as the contract has it: a default proxy cap and a team. */
const ANSWER = {
	v: 1,
	at: "2026-11-07T10:00:00Z",
	default: "proxy",
	total: { "this month": { dollars: 9100, shown: "$9,100" } },
	budgets: [
		{
			name: "proxy",
			label: "Your proxy cap",
			default: true,
			providers: [],
			allowances: [
				{
					name: "weekly",
					label: "the week",
					unit: "dollars",
					allowance: 300,
					spent: 184,
					warn: 0.9,
					state: "ok",
				},
			],
			standing: "$184 of $300",
			nearest: 0.61,
		},
		{
			name: "delta",
			label: "Delta team token",
			providers: [],
			standing: "$12 today",
		},
	],
};

function harness(options: { answer?: unknown; hasUI?: boolean } = {}) {
	const handlers = new Map<string, Handler[]>();
	const bus = new Map<string, ((data: unknown) => void)[]>();
	const statuses: (string | undefined)[] = [];
	let asks = 0;
	const exec: Exec = async () => {
		asks++;
		return options.answer === undefined
			? { code: 127, stdout: "", stderr: "not found" }
			: { code: 0, stdout: JSON.stringify(options.answer), stderr: "" };
	};
	const pi = {
		on: (name: string, handler: Handler) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: {
			on: (channel: string, handler: (data: unknown) => void) => {
				bus.set(channel, [...(bus.get(channel) ?? []), handler]);
				return () => {};
			},
			emit: (channel: string, data: unknown) => {
				for (const handler of bus.get(channel) ?? []) handler(data);
			},
		},
		registerCommand: () => {},
	};
	registerBudgetItem(pi as never, { exec: () => exec, listPrice: () => 1.5 });
	const ctx = {
		hasUI: options.hasUI ?? true,
		model: { provider: "anthropic" },
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: { fg: (_colour: string, text: string) => text },
			setStatus: (_key: string, text: string | undefined) =>
				statuses.push(text),
		},
	};
	const fire = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	/** Let an ask still on its way land. */
	const settle = () => new Promise((resolve) => setImmediate(resolve));
	return { pi, fire, settle, statuses, asks: () => asks };
}

const saved = process.env.PI_BUDGET;
beforeEach(() => {
	delete process.env.PI_BUDGET;
});
afterEach(() => {
	if (saved === undefined) delete process.env.PI_BUDGET;
	else process.env.PI_BUDGET = saved;
});

describe("the budget item", () => {
	it("tells the budget the quest chose, once spend-watch says where it stands", async () => {
		process.env.PI_BUDGET = "delta";
		const item = harness({ answer: ANSWER });
		await item.fire("session_start");
		expect(item.statuses.at(0), "the name before spend-watch answers").toBe(
			`${FOOTER_GLYPH.budget} delta`,
		);
		await item.settle();
		expect(item.statuses.at(-1)).toBe(`${FOOTER_GLYPH.budget} delta $12 today`);
	});

	it("keeps the default quiet, and tells it once the quest settles on one", async () => {
		const item = harness({ answer: ANSWER });
		await item.fire("session_start");
		await item.settle();
		expect(item.statuses.at(-1)).toBeUndefined();

		item.pi.events.emit(BUDGET_SETTLED, { name: "delta" });
		expect(item.statuses.at(-1)).toBe(`${FOOTER_GLYPH.budget} delta $12 today`);
	});

	it("moves with what Claude Code says of the plan after a turn", async () => {
		const item = harness();
		await item.fire("session_start");
		await item.fire("model_select", { model: { provider: "claude-code" } });
		await item.fire("message_end", {
			message: {
				role: "assistant",
				provider: "claude-code",
				diagnostics: [
					{
						type: RATE_LIMIT,
						details: {
							status: "allowed",
							unifiedWindows: { five_hour: { utilization: 0.62 } },
						},
					},
				],
			},
		});
		expect(item.statuses.at(-1)).toBe(
			`${FOOTER_GLYPH.budget} claude 62% of 5 h`,
		);
	});

	it("asks spend-watch after a reply at most once a minute", async () => {
		const item = harness({ answer: ANSWER });
		await item.fire("session_start");
		await item.settle();
		await item.fire("agent_end");
		await item.settle();
		expect(item.asks()).toBe(1);
	});

	it("asks nothing and says nothing with no person at it", async () => {
		process.env.PI_BUDGET = "delta";
		const item = harness({ answer: ANSWER, hasUI: false });
		await item.fire("session_start");
		await item.fire("agent_end");
		await item.settle();
		expect(item.asks()).toBe(0);
		expect(item.statuses).toEqual([]);
	});
});
