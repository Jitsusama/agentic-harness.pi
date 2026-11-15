/**
 * Slack writes through the tool gateway, held to the slack guard as the
 * slack tool's own are: each needs Joel's yes at the screen, since it
 * lands in his name, and none goes with no screen, whatever a session
 * or config sets (item 234, slice 2).
 *
 * The gateway's Slack tools are reached three ways: its helper
 * `tool_gateway_run_tool`, a direct tool its integration registers,
 * and pi's own MCP tool `mcp__tool_gateway__<tool>`, which codemode
 * scripts call. Every one passes pi's `tool_call`, codemode's included.
 * The integration's own write gate already asks at a screen, so this
 * asks only for pi's MCP tool, which nothing else gates, and keeps Joel
 * from being asked twice; with no screen, or while he's away, it
 * refuses all three.
 *
 * A gateway Slack tool counts as a write unless its name says it reads
 * (`slack_read_`, `slack_search_`, `slack_find_`, `slack_who_am_i`) or
 * it only saves a draft Joel sends himself, so a tool the gateway adds
 * later is asked about until it's known.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { confirmGatewayWrite, unasked } from "./confirmation.ts";

/** The gateway's helper that runs any of its tools by name. */
const RUN_TOOL = "tool_gateway_run_tool";

/** How pi names the gateway's tools as an MCP server's. */
const MCP_PREFIX = "mcp__tool_gateway__";

/** Gateway Slack tools that read, by how their names begin. */
const READS = /^slack_(read_|search_|find_|who_am_i$)/;

/** Gateway Slack tools that only save a draft for Joel to send. */
const DRAFTS = new Set(["slack_send_message_draft"]);

/** What pi's tool_call takes to stop a call. */
type Blocked = { readonly block: true; readonly reason: string };

/** A record's fields, or none when the value isn't one. */
function fieldsOf(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null
		? Object.fromEntries(Object.entries(value))
		: {};
}

/** The gateway tool a call runs, and with what, or undefined for any other call. */
function gatewayCall(
	toolName: string,
	input: unknown,
): { tool: string; args: Record<string, unknown>; mcp: boolean } | undefined {
	const fields = fieldsOf(input);
	if (toolName === RUN_TOOL) {
		const name = fields.name;
		return typeof name === "string"
			? { tool: name, args: fieldsOf(fields.arguments), mcp: false }
			: undefined;
	}
	if (toolName.startsWith(MCP_PREFIX))
		return { tool: toolName.slice(MCP_PREFIX.length), args: fields, mcp: true };
	return { tool: toolName, args: fields, mcp: false };
}

/**
 * The gateway Slack tool a call writes with, or undefined when it reads,
 * drafts, or isn't a gateway Slack call.
 */
export function gatewaySlackWrite(
	toolName: string,
	input: unknown,
): string | undefined {
	const tool = gatewayCall(toolName, input)?.tool;
	if (!tool?.startsWith("slack_")) return undefined;
	return READS.test(tool) || DRAFTS.has(tool) ? undefined : tool;
}

/**
 * Whether pi should stop a call: a gateway Slack write with no screen,
 * while Joel is away, or one he turned down; undefined lets it run.
 */
export async function gateGatewayWrite(
	ctx: ExtensionContext,
	toolName: string,
	input: unknown,
): Promise<Blocked | undefined> {
	const tool = gatewaySlackWrite(toolName, input);
	const call = gatewayCall(toolName, input);
	if (!tool || !call) return undefined;
	if (!call.mcp) {
		const skip = unasked(ctx, true as const, `Run ${tool} on Slack`);
		if (skip && !skip.approved) return { block: true, reason: skip.redirect };
		// At a screen the gateway's own write gate asks.
		return undefined;
	}
	const answer = await confirmGatewayWrite(ctx, tool, call.args);
	if (answer?.approved) return undefined;
	return {
		block: true,
		reason: answer ? answer.redirect : `Cancelled: ${tool} wasn't run.`,
	};
}
