/**
 * A quest made with no parent by a session inside an orchestration is
 * refused, naming the parents it could use: made at the top, it answers
 * to no orchestrator, and its sessions join no orchestration's group
 * (Sunday's miss, a Mac cell left unattached that way). A session in no
 * orchestration, or with no quest loaded, makes a top-level quest as
 * before.
 */

import { describe, expect, it } from "vitest";
import { handle } from "../../../../extensions/quest-workflow/transitions.ts";
import { fakePi } from "../../../support/fake-pi.ts";
import { fakeCtx } from "../_helpers.ts";
import { buildState, fixture } from "../support/verbs.ts";

/** A session's quest state and a way to run its verbs. */
function session() {
	const state = buildState();
	const run = (params: Parameters<typeof handle>[3]) =>
		handle(state, fakePi(), fakeCtx(fixture.root), params);
	return { state, run };
}

/** The id a create made, failing the test with its guidance when refused. */
async function made(
	run: ReturnType<typeof session>["run"],
	params: Parameters<typeof handle>[3],
): Promise<string> {
	const result = await run(params);
	if (!result.ok) throw new Error(result.guidance);
	return (result.details as { id: string }).id;
}

/** A session on a quest under an orchestrating quest, and both ids. */
async function inOrchestration() {
	const { state, run } = session();
	const orchestrator = await made(run, {
		action: "create",
		kind: "quest",
		title: "Orchestrator",
	});
	await run({ action: "orchestrate" });
	const child = await made(run, {
		action: "create",
		kind: "subquest",
		title: "Child",
		parent: orchestrator,
	});
	await run({ action: "load", id: child });
	expect(state.questId, "the child is loaded").toBe(child);
	return { state, run, orchestrator, child };
}

describe("making a quest from inside an orchestration", () => {
	it("refuses one with no parent, naming the loaded quest and its orchestrator", async () => {
		const { run, orchestrator, child } = await inOrchestration();

		const result = await run({ action: "create", title: "Stray" });

		expect(result.ok, "a parentless quest was made").toBe(false);
		if (result.ok) return;
		expect(result.guidance, "names the loaded quest").toContain(child);
		expect(result.guidance, "names the orchestrator").toContain(orchestrator);
		expect(result.guidance, "says how to make one at the top").toContain(
			"reparent",
		);
	});

	it("refuses a parent given as null the same way", async () => {
		const { run, child } = await inOrchestration();

		const result = await run({
			action: "create",
			title: "Stray",
			parent: null as unknown as string,
		});

		expect(result.ok, "a quest with a null parent was made").toBe(false);
		if (!result.ok) expect(result.guidance).toContain(child);
	});

	it("refuses the orchestrating session's own parentless quest, naming its quest", async () => {
		const { run } = session();
		const orchestrator = await made(run, {
			action: "create",
			kind: "quest",
			title: "Orchestrator",
		});
		await run({ action: "orchestrate" });

		const result = await run({ action: "create", title: "Stray" });

		expect(result.ok, "a parentless quest was made").toBe(false);
		if (!result.ok) expect(result.guidance).toContain(orchestrator);
	});

	it("makes one under a parent it names", async () => {
		const { run, child } = await inOrchestration();

		const result = await run({
			action: "create",
			kind: "sidequest",
			title: "Kept",
			parent: child,
		});

		expect(result.ok, result.ok ? "" : result.guidance).toBe(true);
	});
});

describe("making a quest from outside any orchestration", () => {
	it("makes a top-level quest while a quest in no orchestration is loaded", async () => {
		const { state, run } = session();
		await made(run, { action: "create", kind: "quest", title: "Plain" });
		expect(state.questId, "a quest is loaded").toBeDefined();

		const result = await run({ action: "create", title: "Another" });

		expect(result.ok, result.ok ? "" : result.guidance).toBe(true);
	});

	it("makes a top-level quest with no quest loaded", async () => {
		const { state, run } = session();
		expect(state.questId, "nothing is loaded").toBeFalsy();

		const result = await run({ action: "create", title: "First" });

		expect(result.ok, result.ok ? "" : result.guidance).toBe(true);
	});
});
