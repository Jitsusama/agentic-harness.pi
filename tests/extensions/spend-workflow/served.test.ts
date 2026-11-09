/**
 * A session records who served its requests only when that changes, so its
 * log gains an entry at a failover rather than one a turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { recordWhoServed } from "../../../extensions/spend-workflow/served.ts";
import { SERVED_ENTRY } from "../../../lib/internal/session/served.ts";

/** A pi that hands its handlers out and records what was appended. */
function fakePi() {
	const handlers = new Map<string, ((event: unknown) => void)[]>();
	const appended: { type: string; data: unknown }[] = [];
	const pi = {
		on: (name: string, handler: (event: unknown) => void) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
	} as unknown as ExtensionAPI;
	const fire = (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) handler(event);
	};
	return { pi, fire, appended };
}

const response = (provider: string) => ({
	type: "after_provider_response",
	status: 200,
	headers: { "x-shopify-proxy-provider": provider, "cf-ray": "a5-ORD" },
});

describe("who served this session", () => {
	it("is recorded at its first response and at each change, never twice", () => {
		const { pi, fire, appended } = fakePi();
		recordWhoServed(pi);

		fire("after_provider_response", response("anthropic-dev"));
		fire("after_provider_response", response("anthropic-dev"));
		fire("after_provider_response", { status: 200, headers: {} });
		fire("after_provider_response", response("bedrock"));

		expect(appended).toEqual([
			{ type: SERVED_ENTRY, data: { backend: "anthropic-dev", edge: "ORD" } },
			{ type: SERVED_ENTRY, data: { backend: "bedrock", edge: "ORD" } },
		]);
	});

	it("is recorded again in a new session's log", () => {
		const { pi, fire, appended } = fakePi();
		recordWhoServed(pi);

		fire("after_provider_response", response("anthropic-dev"));
		fire("session_start");
		fire("after_provider_response", response("anthropic-dev"));

		expect(appended).toHaveLength(2);
	});
});
