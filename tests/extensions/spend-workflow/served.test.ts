/**
 * A session records who served its requests only when that changes, so its
 * log gains an entry at a failover rather than one a turn.
 */

import { describe, expect, it } from "vitest";
import { recordWhoServed } from "../../../extensions/spend-workflow/served.ts";
import { SERVED_ENTRY } from "../../../lib/internal/session/served.ts";
import { fakePi } from "../../support/fake-pi.ts";

/** A pi recording who served it, and a way to fire what it listens for. */
function served() {
	const pi = fakePi();
	recordWhoServed(pi);
	const fire = (name: string, event: unknown = {}) => {
		for (const handler of pi.recorded.handlers.get(name) ?? []) {
			handler(event, {});
		}
	};
	return { fire, entries: pi.recorded.entries };
}

const response = (provider: string) => ({
	type: "after_provider_response",
	status: 200,
	headers: { "x-shopify-proxy-provider": provider, "cf-ray": "a5-ORD" },
});

describe("who served this session", () => {
	it("is recorded at its first response and at each change, never twice", () => {
		const { fire, entries } = served();

		fire("after_provider_response", response("anthropic-dev"));
		fire("after_provider_response", response("anthropic-dev"));
		fire("after_provider_response", { status: 200, headers: {} });
		fire("after_provider_response", response("bedrock"));

		expect(entries).toEqual([
			{
				customType: SERVED_ENTRY,
				data: { backend: "anthropic-dev", edge: "ORD" },
			},
			{ customType: SERVED_ENTRY, data: { backend: "bedrock", edge: "ORD" } },
		]);
	});

	it("is recorded again in a new session's log", () => {
		const { fire, entries } = served();

		fire("after_provider_response", response("anthropic-dev"));
		fire("session_start");
		fire("after_provider_response", response("anthropic-dev"));

		expect(entries).toHaveLength(2);
	});
});
