import { describe, expect, it } from "vitest";
import {
	changedValues,
	runSurfaceConfigPanel,
	type SurfaceConfigPanelInput,
} from "../../../lib/mcp/config-panel.js";

function input(): SurfaceConfigPanelInput {
	return {
		title: "Tool Gateway",
		sections: [
			{
				title: "slack",
				rows: [
					{
						id: "slack_post",
						label: "slack_post",
						options: ["direct", "progressive", "disabled"],
						index: 0,
					},
					{
						id: "slack_read",
						label: "slack_read",
						options: ["direct", "progressive", "disabled"],
						index: 0,
					},
				],
			},
		],
	};
}

describe("changedValues", () => {
	it("returns only rows whose value differs from the initial selection", () => {
		const changed = changedValues(input(), {
			slack_post: "disabled",
			slack_read: "direct",
		});
		expect(changed).toEqual({ slack_post: "disabled" });
	});

	it("returns nothing when every value matches the initial selection", () => {
		expect(
			changedValues(input(), { slack_post: "direct", slack_read: "direct" }),
		).toEqual({});
	});
});

describe("runSurfaceConfigPanel", () => {
	it("returns null in a headless context (no change possible)", async () => {
		const ctx = { hasUI: false } as never;
		expect(await runSurfaceConfigPanel(ctx, input())).toBeNull();
	});
});
