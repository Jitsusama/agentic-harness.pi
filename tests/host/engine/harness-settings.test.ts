/** Each hosted conversation says how it was launched, keeping what the host's launch checked. */
import { expect, it } from "vitest";
import { harnessSettings } from "../../../host/engine/harness-settings.ts";

/** What Shopify's launcher wrote for an interactive pi it resumed. */
const HOST = JSON.stringify({
	config_checked: "full",
	harness: "pi",
	harness_version: "0.0.1-launcher",
	launch_mode: "resume",
	model_source: "cli",
	reasoning_source: "cli",
	router_opt_out: false,
	saved_reasoning: "high",
	surface: "interactive",
	v: "1",
});
/** The pi the engine loaded, as it would pass it. */
const ENGINE = { version: "9.9.9-engine" };

function read(value: string): Record<string, unknown> {
	return JSON.parse(value);
}

it("says a background conversation opened fresh, on the default model", () => {
	expect(
		read(harnessSettings(HOST, { attended: false }, { op: "open" }, ENGINE)),
	).toEqual({
		config_checked: "full",
		harness: "pi",
		harness_version: "9.9.9-engine",
		launch_mode: "fresh",
		model_source: "default",
		reasoning_source: "default",
		router_opt_out: false,
		saved_reasoning: "high",
		surface: "background",
		v: "1",
	});
});

it("says the model and reasoning came from the open request when it named them", () => {
	const settings = read(
		harnessSettings(
			HOST,
			{ attended: true },
			{
				op: "open",
				model: { provider: "anthropic", id: "a-model" },
				thinkingLevel: "low",
			},
			ENGINE,
		),
	);
	expect(settings).toMatchObject({
		surface: "interactive",
		launch_mode: "fresh",
		model_source: "cli",
		reasoning_source: "cli",
	});
});

it("says an adopted conversation resumed, keeping the host's sources", () => {
	expect(
		read(harnessSettings(HOST, { attended: true }, { op: "adopt" }, ENGINE)),
	).toMatchObject({
		launch_mode: "resume",
		model_source: "cli",
		reasoning_source: "cli",
	});
});

it("says a conversation carried over a host restart was restored", () => {
	expect(
		read(harnessSettings(HOST, { attended: false }, undefined, ENGINE)),
	).toMatchObject({
		launch_mode: "restore",
		surface: "background",
		model_source: "cli",
	});
});

it("builds the settings from the conversation alone when the host has none", () => {
	for (const base of [undefined, "", "not json", "[1,2]"]) {
		expect(
			read(harnessSettings(base, { attended: true }, { op: "open" }, ENGINE)),
			`from ${JSON.stringify(base)}`,
		).toEqual({
			harness: "pi",
			harness_version: "9.9.9-engine",
			launch_mode: "fresh",
			model_source: "default",
			reasoning_source: "default",
			surface: "interactive",
			v: "1",
		});
	}
});

it("writes its keys in order, as the launcher does", () => {
	const keys = Object.keys(
		read(harnessSettings(HOST, { attended: false }, { op: "open" }, ENGINE)),
	);
	expect(keys).toEqual([...keys].sort());
});
