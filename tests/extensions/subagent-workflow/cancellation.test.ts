import { describe, expect, it } from "vitest";
import {
	FleetCancellationRegistry,
	formatFleetCancellation,
	isSubagentCancelledError,
	SubagentCancelledError,
} from "../../../extensions/subagent-workflow/cancellation";

// The registry mirrors pr-workflow's review-shaped one,
// but speaks subagent vocabulary and has no review-
// operation coupling. These tests pin the load-bearing
// behaviour: abort signals fire on cancel, pre-cancelled
// ids abort their subagent on registration, formatting
// surfaces actionable strings to the tool output.

describe("FleetCancellationRegistry", () => {
	it("aborts an active subagent's signal on cancel(id)", () => {
		const registry = new FleetCancellationRegistry();
		const run = registry.beginRun("r");
		const handle = run.register({ id: "alpha" }, undefined);
		const outcome = registry.cancel("r", "alpha");
		expect(handle.signal.aborted).toBe(true);
		expect(handle.wasCancelledByUser()).toBe(true);
		expect(outcome.ok).toBe(true);
		if (outcome.ok && outcome.mode === "one") {
			expect(outcome.subagentId).toBe("alpha");
		}
		run.end();
	});

	it("cancels every active subagent on cancel()", () => {
		const registry = new FleetCancellationRegistry();
		const run = registry.beginRun("r");
		const a = run.register({ id: "alpha" }, undefined);
		const b = run.register({ id: "beta" }, undefined);
		const outcome = registry.cancel("r");
		expect(a.signal.aborted).toBe(true);
		expect(b.signal.aborted).toBe(true);
		expect(outcome.ok).toBe(true);
		if (outcome.ok && outcome.mode === "all") {
			expect(outcome.count).toBe(2);
		}
		run.end();
	});

	it("aborts subagents that register after a pre-emptive cancel", () => {
		// Cancellation requests can arrive before a
		// subagent has been registered (UI fires before
		// the engine has reached that assignment in the
		// Promise.all). The registry stashes the id and
		// aborts on registration so the race doesn't
		// silently start a doomed subprocess.
		const registry = new FleetCancellationRegistry();
		const run = registry.beginRun("r");
		registry.cancel("r", "late");
		const handle = run.register({ id: "late" }, undefined);
		expect(handle.signal.aborted).toBe(true);
		expect(handle.wasCancelledByUser()).toBe(true);
		run.end();
	});

	it("propagates a parent abort signal", () => {
		// When the tool execution is itself aborted (the
		// host signals via execute's signal), every
		// active subagent must wind down with it.
		const registry = new FleetCancellationRegistry();
		const run = registry.beginRun("r");
		const parent = new AbortController();
		const handle = run.register({ id: "child" }, parent.signal);
		parent.abort();
		expect(handle.signal.aborted).toBe(true);
		run.end();
	});

	it("cancels within one fleet when two run at once", () => {
		// Pi runs a turn's tool calls side by side, so two fleets can be
		// up together, each with its own board, and job ids are the
		// caller's, so both can have an "alpha". A key on one board must
		// reach only that board's fleet.
		const registry = new FleetCancellationRegistry();
		const one = registry.beginRun("one");
		const two = registry.beginRun("two");
		const oneAlpha = one.register({ id: "alpha" }, undefined);
		const twoAlpha = two.register({ id: "alpha" }, undefined);
		const twoBeta = two.register({ id: "beta" }, undefined);

		expect(registry.cancel("one", "alpha").ok).toBe(true);
		expect(oneAlpha.signal.aborted).toBe(true);
		expect(twoAlpha.signal.aborted).toBe(false);

		registry.cancel("one");
		expect(twoAlpha.signal.aborted).toBe(false);
		expect(twoBeta.signal.aborted).toBe(false);

		registry.cancel("two", "beta");
		expect(twoBeta.signal.aborted).toBe(true);
		expect(twoAlpha.signal.aborted).toBe(false);
		one.end();
		two.end();
	});

	it("stashes an early cancel for its own fleet only", () => {
		const registry = new FleetCancellationRegistry();
		const one = registry.beginRun("one");
		const two = registry.beginRun("two");
		registry.cancel("one", "late");
		expect(two.register({ id: "late" }, undefined).signal.aborted).toBe(false);
		expect(one.register({ id: "late" }, undefined).signal.aborted).toBe(true);
		one.end();
		two.end();
	});

	it("reports failure when nothing matches the cancel target", () => {
		const registry = new FleetCancellationRegistry();
		const outcome = registry.cancel("r", "nobody");
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error).toContain("nobody");
	});
});

describe("formatFleetCancellation", () => {
	it("renders single and bulk cancellations distinctly", () => {
		expect(
			formatFleetCancellation({ ok: true, mode: "one", subagentId: "alpha" }),
		).toBe("Cancellation requested for alpha.");
		expect(formatFleetCancellation({ ok: true, mode: "all", count: 3 })).toBe(
			"Cancellation requested for 3 active subagents.",
		);
		expect(formatFleetCancellation({ ok: true, mode: "all", count: 1 })).toBe(
			"Cancellation requested for 1 active subagent.",
		);
	});

	it("renders failures as the raw error text", () => {
		expect(
			formatFleetCancellation({ ok: false, error: "nothing to cancel" }),
		).toBe("nothing to cancel");
	});
});

describe("SubagentCancelledError", () => {
	it("is recognised by isSubagentCancelledError", () => {
		const err = new SubagentCancelledError("alpha");
		expect(isSubagentCancelledError(err)).toBe(true);
		expect(err.subagentId).toBe("alpha");
		expect(isSubagentCancelledError(new Error("other"))).toBe(false);
	});
});
