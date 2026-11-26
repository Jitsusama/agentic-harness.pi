/** How a host lets go of a conversation's runtime: left for the next host, or closed for good. */
import { describe, expect, it } from "vitest";
import {
	disposeRuntime,
	leavesItsRun,
	type RuntimeEnding,
} from "../../../host/engine/runtime-release.ts";

/** A runtime that records what each dispose was asked. */
function recordingRuntime() {
	const asked: unknown[] = [];
	return {
		asked,
		dispose: (options?: { readonly leaveRun?: boolean }) => {
			asked.push(options);
			return Promise.resolve();
		},
	};
}

describe("letting go of a conversation's runtime", () => {
	it.each<[string, RuntimeEnding]>([
		["a park, before any stamp", undefined],
		["a host's stop or restart", "signalled"],
	])("leaves the run for the next host on %s", async (_, ending) => {
		const runtime = recordingRuntime();
		await disposeRuntime(runtime, ending);
		expect(leavesItsRun(ending), `an ending of ${ending} leaves its run`).toBe(
			true,
		);
		expect(runtime.asked).toEqual([{ leaveRun: true }]);
	});

	it("ends the run of a conversation closed for good", async () => {
		const runtime = recordingRuntime();
		await disposeRuntime(runtime, "closed");
		expect(leavesItsRun("closed"), "a closed conversation ends its run").toBe(
			false,
		);
		expect(runtime.asked).toEqual([undefined]);
	});
});
