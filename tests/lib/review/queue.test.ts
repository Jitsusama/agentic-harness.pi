import { describe, expect, it } from "vitest";
import { queueRefusal } from "../../../lib/review/queue.js";

describe("queueRefusal", () => {
	it("permits a mutation when the change is not queued", () => {
		expect(queueRefusal({ posture: "unqueued" }, "github")).toBeUndefined();
	});

	it("permits a mutation when the provider does not report a queue", () => {
		// Absent is unknown, not queued. A provider with no queue at all
		// must not have every mutation refused on suspicion.
		expect(queueRefusal(undefined, "git")).toBeUndefined();
	});

	it("refuses while queued, and says ejection is the cost", () => {
		const refusal = queueRefusal({ posture: "queued" }, "github");

		expect(refusal?.reason).toContain("queued to merge");
		expect(refusal?.instead).toContain("Cancel the merge");
	});

	it("names the batch as the cost when it is not being tested alone", () => {
		// The expensive case: ejecting a batched change re-runs the checks
		// for everything batched with it.
		const refusal = queueRefusal({ posture: "queued", solo: false }, "github");

		expect(refusal?.reason).toContain("batched with it");
	});

	it("does not blame a batch when the change is queued alone", () => {
		// Being alone in the queue makes ejection cheap, and a refusal that
		// overstates the cost teaches the reader to ignore it.
		const refusal = queueRefusal({ posture: "queued", solo: true }, "github");

		expect(refusal?.reason).not.toContain("batched with it");
		expect(refusal?.reason).toContain("queued to merge");
	});

	it("counts the position when the backend reports one", () => {
		const refusal = queueRefusal(
			{ posture: "queued", position: 3, solo: false },
			"github",
		);

		expect(refusal?.reason).toContain("3rd");
	});

	it("refuses while waiting, because the checks will not run again", () => {
		// A distinct hazard from ejection: a change waiting on checks has
		// already had its one run, and a new commit does not retrigger it.
		const refusal = queueRefusal({ posture: "waiting" }, "github");

		expect(refusal?.reason).toContain("waiting");
		expect(refusal?.instead).toBeTruthy();
	});

	it("says something different for waiting than for queued", () => {
		// The two hazards have different fixes, and one message covering
		// both would name neither.
		const waiting = queueRefusal({ posture: "waiting" }, "github");
		const queued = queueRefusal({ posture: "queued" }, "github");

		expect(waiting?.instead).not.toEqual(queued?.instead);
	});

	it("quotes what the backend said, when it said anything", () => {
		const refusal = queueRefusal(
			{ posture: "queued", detail: "Waiting for CI to pass on batch 41" },
			"gitstream",
		);

		expect(refusal?.reason).toContain("Waiting for CI to pass on batch 41");
	});

	it("names the provider that is refusing", () => {
		const refusal = queueRefusal({ posture: "queued" }, "gitstream");

		expect(refusal?.reason).toContain("gitstream");
	});
});
