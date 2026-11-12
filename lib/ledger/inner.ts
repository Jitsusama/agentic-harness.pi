/**
 * The calls one tool made to others, read off its result.
 *
 * A codemode script calls tools from inside one call, so the log's own
 * call blocks show only `codemode`, and a session that did its work in
 * scripts reads as never calling what it called (Declared, Called, 12
 * November 2026). pi 1.5 keeps a script's calls on its result as
 * `nestedCalls`; the script's own `details.calls` carries the same for
 * logs pi kept none in. A gateway call names the tool it ran in its
 * arguments. Each becomes one record, never with its arguments, which
 * can hold secrets and run large.
 */

import { createHash } from "node:crypto";
import type { InnerCallRecord } from "../core/observability/index.ts";
import { isRecord } from "../internal/record.ts";

/** The tool that runs another tool by name, through the gateway. */
export const GATEWAY_TOOL = "tool_gateway_run_tool";

/** The tool whose result carries a script's calls. */
const SCRIPT_TOOL = "codemode";

/** Width of a stored content address, as the scan's own. */
const DIGEST_CHARS = 24;

/** The outer call, as the scan holds it. */
export interface OuterCall {
	readonly digest: string;
	readonly sessionId: string;
	readonly entryId: string;
	readonly callId: string;
	readonly timestamp: string;
	readonly name: string;
}

/** The tool a gateway call ran, from its arguments, if it names one. */
export function gatewayTarget(args: unknown): string | undefined {
	const named = recordOf(args)?.name;
	return typeof named === "string" && named.length > 0 ? named : undefined;
}

/**
 * The calls an outer call made, from its result: a script's from pi's
 * record first and the script's details otherwise, or the one tool a
 * gateway call ran, `target`, named when the call was made.
 */
export function innerCallsOf(
	outer: OuterCall,
	result: Record<string, unknown>,
	target: string | undefined,
): InnerCallRecord[] {
	if (outer.name === GATEWAY_TOOL) {
		if (!target) return [];
		const status = result.isError === true ? "error" : "ok";
		return [
			record(outer, outer.callId, target, "tool_gateway_run_tool", status, {
				durationMs: result.durationMs,
			}),
		];
	}
	if (outer.name !== SCRIPT_TOOL) return [];
	return scriptCalls(result).flatMap((call, at) => {
		const name = typeof call.name === "string" ? call.name : undefined;
		if (!name) return [];
		const through = name === GATEWAY_TOOL ? targetOf(call) : undefined;
		const id = typeof call.id === "string" ? call.id : `${outer.callId}/${at}`;
		const status = typeof call.status === "string" ? call.status : "ok";
		return [
			through
				? record(outer, id, through, "tool_gateway_run_tool", status, call)
				: record(outer, id, name, "codemode", status, call),
		];
	});
}

/** A script's calls: pi's own record where it kept one, else the script's. */
function scriptCalls(
	result: Record<string, unknown>,
): Record<string, unknown>[] {
	const kept = recordOf(result.nestedCalls)?.calls;
	const own = recordOf(result.details)?.calls;
	const list = Array.isArray(kept) ? kept : Array.isArray(own) ? own : [];
	return list.flatMap((call) => {
		const one = recordOf(call);
		return one ? [one] : [];
	});
}

/**
 * The tool a gateway call inside a script ran: pi keeps its arguments
 * as an object, a script's details as JSON text.
 */
function targetOf(call: Record<string, unknown>): string | undefined {
	if (call.arguments !== undefined) return gatewayTarget(call.arguments);
	if (typeof call.args !== "string") return undefined;
	try {
		return gatewayTarget(JSON.parse(call.args));
	} catch {
		// Arguments a script cut short aren't JSON: its tool stays unnamed.
		return undefined;
	}
}

function record(
	outer: OuterCall,
	id: string,
	name: string,
	via: InnerCallRecord["via"],
	status: string,
	timed: { readonly durationMs?: unknown },
): InnerCallRecord {
	return {
		digest: digestText(JSON.stringify([outer.digest, id, name])),
		sessionId: outer.sessionId,
		entryId: outer.entryId,
		outerCallId: outer.callId,
		timestamp: outer.timestamp,
		name,
		via,
		status,
		durationMs:
			typeof timed.durationMs === "number" && Number.isFinite(timed.durationMs)
				? Math.round(timed.durationMs)
				: null,
	};
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function digestText(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, DIGEST_CHARS);
}
