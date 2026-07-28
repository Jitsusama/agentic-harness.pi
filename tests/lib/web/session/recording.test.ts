import { beforeEach, describe, expect, it } from "vitest";
import {
	claimRecording,
	describeRecording,
	recordingInProgress,
	releaseRecording,
} from "../../../../lib/web/session/recording.js";

/** The permit is process-wide, so each test starts from nothing held. */
beforeEach(() => {
	releaseRecording();
});

const held = (value: ReturnType<typeof claimRecording>) =>
	"refusal" in value ? undefined : value;

describe("claimRecording", () => {
	it("grants the permit when nothing is recording", () => {
		const claim = claimRecording("checkout", ["async"]);

		expect(held(claim)?.session).toBe("checkout");
		expect(recordingInProgress()?.session).toBe("checkout");
	});

	it("refuses a second claim and names who is holding it", () => {
		claimRecording("checkout", ["async"]);
		const second = claimRecording("search", ["frames"]);

		expect("refusal" in second).toBe(true);
		if (!("refusal" in second)) return;
		// The reader's next move is to go and stop that one, so the
		// refusal has to say which session to go to.
		expect(second.refusal).toContain("checkout");
		expect(second.held.session).toBe("checkout");
	});

	it("grants the permit again once it is released", () => {
		claimRecording("checkout", ["async"]);
		releaseRecording();
		const second = claimRecording("search", ["frames"]);

		expect(held(second)?.session).toBe("search");
	});

	it("has nothing in progress before anyone claims", () => {
		expect(recordingInProgress()).toBeUndefined();
	});
});

describe("describeRecording", () => {
	it("says nothing when no recording is running", () => {
		expect(describeRecording(undefined, "checkout")).toBeUndefined();
	});

	it("tells a bystander which session is costing them", () => {
		const claim = claimRecording("checkout", ["async"]);
		const recording = held(claim);
		if (recording === undefined) throw new Error("expected the permit");

		const text = describeRecording(recording, "search");

		expect(text).toContain("session checkout");
		// The point of saying it in a bystander's status at all.
		expect(text).toMatch(/every page/i);
	});

	it("speaks plainly to the session that started it", () => {
		const claim = claimRecording("checkout", ["frames"]);
		const recording = held(claim);
		if (recording === undefined) throw new Error("expected the permit");

		const text = describeRecording(recording, "checkout");

		expect(text).toContain("this session");
		expect(text).not.toContain("session checkout");
	});

	it("names the profiles being recorded", () => {
		const claim = claimRecording("checkout", ["async", "frames"]);
		const recording = held(claim);
		if (recording === undefined) throw new Error("expected the permit");

		expect(describeRecording(recording, "checkout")).toContain(
			"async and frames",
		);
	});
});
