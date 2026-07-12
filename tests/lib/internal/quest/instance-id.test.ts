import { describe, expect, it } from "vitest";
import { currentInstanceId } from "../../../../lib/internal/quest/process-liveness";

describe("currentInstanceId", () => {
	it("returns a stable non-empty id across calls in one process", () => {
		const a = currentInstanceId();
		const b = currentInstanceId();
		expect(a.length).toBeGreaterThan(0);
		expect(a).toBe(b);
	});
});
