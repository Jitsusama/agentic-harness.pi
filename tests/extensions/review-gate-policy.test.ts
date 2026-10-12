/**
 * The review tools' gates under the guard policy.
 *
 * A reporting guard approves without opening a panel and leaves what
 * the panel would have shown in the transcript; a blocking one asks as
 * the gates always have. A gate named for no guard asks, so a caller
 * from before the policy keeps its behaviour.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	confirmBatch,
	confirmWrite,
} from "../../extensions/review-integration/gate.ts";
import {
	declareGuard,
	restoreSessionModes,
	setSessionMode,
} from "../../lib/guardian/policy.ts";
import {
	type GuardReport,
	setGuardReportSink,
} from "../../lib/guardian/report.ts";

const GUARD = "review-say";
let reports: GuardReport[];
let panels: number;

function context(): ExtensionContext {
	return {
		hasUI: true,
		ui: {
			setStatus: () => {},
			custom: async () => {
				panels += 1;
				return undefined;
			},
		},
	} as unknown as ExtensionContext;
}

beforeEach(() => {
	declareGuard({
		name: GUARD,
		class: "approval",
		description: "Replies on a change.",
		defaultMode: "report",
	});
	restoreSessionModes({});
	reports = [];
	panels = 0;
	setGuardReportSink((r) => reports.push(r));
});

afterEach(() => {
	setGuardReportSink(undefined);
	restoreSessionModes({});
});

describe("a review gate under the policy", () => {
	it("approves without a panel and reports what it would have shown", async () => {
		const decision = await confirmWrite(
			context(),
			"Reply",
			"Thanks, fixed.",
			GUARD,
		);

		expect(decision).toEqual({ approved: true });
		expect(panels).toBe(0);
		expect(reports).toMatchObject([{ guard: GUARD, kind: "shown" }]);
		expect(reports[0]?.body).toContain("Thanks, fixed.");
	});

	it("approves every item of a batch at once", async () => {
		const decision = await confirmBatch(
			context(),
			"Post 2 Things",
			[
				{
					label: "T1",
					views: [{ key: "1", label: "Reply", content: () => [] }],
				},
				{
					label: "T2",
					views: [{ key: "1", label: "Reply", content: () => [] }],
				},
			],
			GUARD,
		);

		expect(decision).toEqual({ proceed: true, accepted: [0, 1], rejected: [] });
		expect(panels).toBe(0);
	});

	it("asks once the guard blocks", async () => {
		setSessionMode(GUARD, "block");

		await confirmWrite(context(), "Reply", "Thanks, fixed.", GUARD);

		expect(panels).toBe(1);
		expect(reports).toEqual([]);
	});

	it("asks when no guard is named", async () => {
		await confirmWrite(context(), "Reply", "Thanks, fixed.");

		expect(panels).toBe(1);
	});
});
