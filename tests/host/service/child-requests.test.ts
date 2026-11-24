// The host's words for a begin it refused as too late.
import { describe, expect, it } from "vitest";
import { beganTooLate } from "../../../host/service/child-requests.ts";

describe("a begin refused as too late", () => {
	// F17 on #2097: each part rounded alone could add up past the whole.
	it("says a weighing and a turn's wait that add up to the time it spent", () => {
		const reply = beganTooLate("open-1", 2_400, 10_000, {
			kind: "turn",
			weighedMs: 1_500,
		});

		expect(reply.ok ? "" : reply.error.message).toContain(
			"The host spent 2 s of its 10 s before it could begin this one, 2 s weighing the conversations it runs and 0 s waiting for its turn",
		);
	});
});
