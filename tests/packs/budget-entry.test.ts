/**
 * A subagent says the budget it draws on in its own log.
 *
 * Subagents start with `--no-extensions`, so the quest workflow that
 * writes this entry in a person's session never runs in them; without
 * the pack, spend read from the logs bills their runs to no budget.
 */

import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUDGET_ENTRY } from "../../lib/budget/record.ts";
import { runReviewer } from "../../lib/subagent/subagent.ts";
import budgetEntry from "../../packs/budget-entry/index.ts";

type Start = (event: unknown, ctx: unknown) => void;

let was: string | undefined;

beforeEach(() => {
	was = process.env.PI_BUDGET;
});

afterEach(() => {
	if (was === undefined) delete process.env.PI_BUDGET;
	else process.env.PI_BUDGET = was;
});

/** The entries the pack appends when a session with this branch starts. */
function started(branch: readonly unknown[] = []) {
	const appended: { type: string; data: unknown }[] = [];
	let start: Start | undefined;
	const pi = {
		on(event: string, handler: Start) {
			if (event === "session_start") start = handler;
		},
		appendEntry(type: string, data: unknown) {
			appended.push({ type, data });
		},
	};
	budgetEntry(pi as never);
	if (start === undefined) throw new Error("the pack heard no session start");
	start({ reason: "startup" }, { sessionManager: { getBranch: () => branch } });
	return appended;
}

describe("a subagent's budget entry", () => {
	it("names the budget the subagent inherited", () => {
		process.env.PI_BUDGET = "delta";

		expect(started()).toEqual([
			{ type: BUDGET_ENTRY, data: { v: 1, name: "delta" } },
		]);
	});

	it("says the default when the subagent inherited none", () => {
		delete process.env.PI_BUDGET;

		expect(started()).toEqual([
			{ type: BUDGET_ENTRY, data: { v: 1, name: null } },
		]);
	});

	it("writes nothing more when a resumed log already ends on that budget", () => {
		process.env.PI_BUDGET = "delta";
		const branch = [
			{
				type: "custom",
				customType: BUDGET_ENTRY,
				data: { v: 1, name: "delta" },
			},
		];

		expect(started(branch)).toEqual([]);
	});

	it("says the new budget when a resumed log ends on another", () => {
		process.env.PI_BUDGET = "aquifer";
		const branch = [
			{
				type: "custom",
				customType: BUDGET_ENTRY,
				data: { v: 1, name: "delta" },
			},
		];

		expect(started(branch)).toEqual([
			{ type: BUDGET_ENTRY, data: { v: 1, name: "aquifer" } },
		]);
	});

	it("is loaded into every reviewer", async () => {
		const runs: string[][] = [];
		const answer = JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "{}" }] },
		});

		await runReviewer({
			reviewer: { id: "a" },
			prompt: "p",
			cwd: "/t",
			runPi: async (opts) => {
				runs.push(opts.args);
				return { stdout: answer, stderr: "", exitCode: 0 };
			},
		});

		const args = runs[0] ?? [];
		const packs = args.filter((_, at) => args[at - 1] === "--extension");
		const pack = packs.find((path) =>
			path.endsWith("packs/budget-entry/index.ts"),
		);
		expect(pack).toBeDefined();
		expect(existsSync(pack ?? ""), `${pack} exists`).toBe(true);
	});
});
