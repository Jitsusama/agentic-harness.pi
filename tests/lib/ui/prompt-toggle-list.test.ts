import { describe, expect, it } from "vitest";
import {
	cycleSelected,
	initToggleModel,
	moveSelection,
	selectedValues,
	setFilter,
	type ToggleListConfig,
	visibleOrder,
} from "../../../lib/ui/prompt-toggle-list.js";

function config(): ToggleListConfig {
	return {
		title: "Config",
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
						index: 1,
					},
				],
			},
			{
				title: "verbosity",
				rows: [
					{
						id: "truncate",
						label: "outputTruncation",
						options: ["on", "off"],
						index: 0,
					},
				],
			},
		],
	};
}

describe("toggle-list model", () => {
	it("initialises selection at the top with no filter", () => {
		const model = initToggleModel(config());
		expect(model.selected).toBe(0);
		expect(model.filter).toBe("");
		expect(visibleOrder(model)).toHaveLength(3);
	});

	it("clamps navigation to the visible range", () => {
		const model = initToggleModel(config());
		expect(moveSelection(model, -1).selected).toBe(0);
		expect(moveSelection(model, 99).selected).toBe(2);
	});

	it("cycles the selected row's value with wraparound", () => {
		let model = initToggleModel(config());
		model = cycleSelected(model); // slack_post: direct -> progressive
		expect(selectedValues(model).slack_post).toBe("progressive");
		model = cycleSelected(cycleSelected(model)); // -> disabled -> direct
		expect(selectedValues(model).slack_post).toBe("direct");
	});

	it("filters rows by label and resets the selection", () => {
		const model = setFilter(
			moveSelection(initToggleModel(config()), 2),
			"truncat",
		);
		expect(visibleOrder(model)).toHaveLength(1);
		expect(model.selected).toBe(0);
		expect(selectedValues(model).truncate).toBe("on");
	});

	it("reads every row's selected value regardless of filter", () => {
		const values = selectedValues(
			setFilter(initToggleModel(config()), "slack"),
		);
		expect(values).toEqual({
			slack_post: "direct",
			slack_read: "progressive",
			truncate: "on",
		});
	});
});
