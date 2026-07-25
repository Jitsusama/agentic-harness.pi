import { describe, expect, it } from "vitest";
import {
	diffStyles,
	renderVariants,
} from "../../../../lib/web/element/index.js";

const AT_REST = [
	{
		name: "paint",
		entries: [
			{ property: "background-color", value: "rgb(238, 238, 238)" },
			{ property: "color", value: "rgb(0, 0, 0)" },
		],
	},
];

describe("diffStyles", () => {
	it("reports only what changed", () => {
		const changed = diffStyles(AT_REST, [
			{
				name: "paint",
				entries: [
					{ property: "background-color", value: "rgb(204, 204, 238)" },
					{ property: "color", value: "rgb(0, 0, 0)" },
				],
			},
		]);
		expect(changed).toEqual([
			{
				property: "background-color",
				from: "rgb(238, 238, 238)",
				to: "rgb(204, 204, 238)",
			},
		]);
	});

	it("reports a property that only appears while held", () => {
		// A focus ring is the case that matters: absent at rest,
		// present on focus, and the whole point of looking.
		const changed = diffStyles(AT_REST, [
			...AT_REST,
			{
				name: "paint",
				entries: [{ property: "outline-style", value: "solid" }],
			},
		]);
		expect(changed).toEqual([
			{ property: "outline-style", from: "not set", to: "solid" },
		]);
	});

	it("reports a property that disappears while held", () => {
		const changed = diffStyles(AT_REST, [
			{
				name: "paint",
				entries: [
					{ property: "background-color", value: "rgb(238, 238, 238)" },
				],
			},
		]);
		expect(changed).toEqual([
			{ property: "color", from: "rgb(0, 0, 0)", to: "not set" },
		]);
	});

	it("reports nothing when a state changes nothing", () => {
		expect(diffStyles(AT_REST, AT_REST)).toEqual([]);
	});
});

describe("renderVariants", () => {
	it("says what each state changed", () => {
		expect(
			renderVariants([
				{
					state: "focus",
					changes: [
						{ property: "outline-style", from: "not set", to: "solid" },
					],
				},
			]),
		).toBe("focus:\n  outline-style: not set -> solid");
	});

	it("says out loud when a state changes nothing", () => {
		// Silence would read as "not checked". A control with no
		// focus style is a finding, not an absence of one.
		expect(renderVariants([{ state: "focus", changes: [] }])).toBe(
			"focus: nothing changes",
		);
	});
});
