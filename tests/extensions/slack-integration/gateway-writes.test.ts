/**
 * A Slack write through the tool gateway needs Joel's yes at the screen,
 * as the slack tool's own do, however it's called: by the gateway's
 * helper, as a direct tool, or as pi's own MCP tool from a codemode
 * script (item 234, slice 2).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	gateGatewayWrite,
	gatewaySlackWrite,
} from "../../../extensions/slack-integration/gateway-writes.ts";
import {
	restoreSessionModes,
	setSessionMode,
} from "../../../lib/guardian/policy.ts";
import {
	declareGuards,
	GUARDS,
} from "../../../lib/internal/guardian/guards.ts";

/** A session nobody sits at. */
const NO_SCREEN = { hasUI: false } as unknown as ExtensionContext;

/** A session the person sits at. */
const SCREEN = { hasUI: true } as unknown as ExtensionContext;

/** Each way a gateway tool is called, as pi's tool_call sees it. */
const calls = (tool: string) =>
	[
		["the gateway's helper", "tool_gateway_run_tool", { name: tool }],
		["a direct tool", tool, {}],
		["pi's own MCP tool", `mcp__tool_gateway__${tool}`, {}],
	] as const;

beforeAll(() => declareGuards(GUARDS.slack));
afterEach(() => restoreSessionModes({}));

describe("which gateway calls write to Slack", () => {
	it.each(["slack_update_canvas", "slack_create_canvas", "slack_post_message"])(
		"counts %s as a write, however it's called",
		(tool) => {
			for (const [how, name, input] of calls(tool))
				expect(gatewaySlackWrite(name, input), how).toBe(tool);
		},
	);

	it.each([
		"slack_read_channel",
		"slack_read_canvas",
		"slack_search_public",
		"slack_find_group_dm",
		"slack_who_am_i",
		"slack_send_message_draft",
	])("lets %s by, since it reads or only drafts", (tool) => {
		for (const [how, name, input] of calls(tool))
			expect(gatewaySlackWrite(name, input), how).toBeUndefined();
	});

	it("leaves the slack tool's own calls and other backends to their gates", () => {
		expect(gatewaySlackWrite("slack", { action: "send_message" })).toBe(
			undefined,
		);
		expect(
			gatewaySlackWrite("tool_gateway_run_tool", { name: "observe_query" }),
			"another backend",
		).toBeUndefined();
		expect(
			gatewaySlackWrite("tool_gateway_run_tool", {}),
			"no name",
		).toBeUndefined();
	});
});

describe("a gateway Slack write", () => {
	it.each(calls("slack_update_canvas"))(
		"through %s is refused with no screen, whatever guard is off",
		async (_how, name, input) => {
			for (const key of [undefined, GUARDS.slack.name, "send", "all"]) {
				if (key) setSessionMode(key, "off");
				const gated = await gateGatewayWrite(NO_SCREEN, name, input);
				expect(gated, `${key ?? "nothing"} off let it through`).toMatchObject({
					block: true,
					reason: expect.stringContaining("no one is at this session"),
				});
				restoreSessionModes({});
			}
		},
	);

	it("through the gateway's own tools is left to its gate at a screen, so Joel is asked once", async () => {
		for (const [how, name, input] of calls("slack_update_canvas").slice(0, 2))
			expect(await gateGatewayWrite(SCREEN, name, input), how).toBeUndefined();
	});

	it("lets a read through with no screen", async () => {
		expect(
			await gateGatewayWrite(
				NO_SCREEN,
				"mcp__tool_gateway__slack_read_channel",
				{},
			),
		).toBeUndefined();
	});
});
