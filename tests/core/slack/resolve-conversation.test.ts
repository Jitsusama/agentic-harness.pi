/**
 * Naming a conversation to Slack by a person's handle.
 *
 * A bare handle passed as the channel, as in reading DMs with
 * `darren.worrall`, was searched for only as a channel and failed as an
 * unknown one. A channel name holds neither a dot nor an @, so such a name
 * is a person, and a bare name no channel answers to may be one too.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackClient } from "../../../lib/core/slack/index.ts";
import { resolveConversation } from "../../../lib/core/slack/resolvers/conversation.ts";

// Both caches live under the real home directory, so the tests keep their
// own rather than reading or writing the developer's.
const cached = new Map<string, string>();
vi.mock("../../../lib/core/slack/resolvers/cache.ts", () => ({
	lookupId: (_file: string, name: string) => cached.get(name),
	lookupName: () => undefined,
	listCached: () => [],
	cacheMapping: (_file: string, name: string, id: string) => {
		cached.set(name, id);
	},
}));
vi.mock("../../../lib/core/slack/resolvers/conversation-cache.ts", () => ({
	getCachedConversation: () => undefined,
	cacheConversation: () => {},
	fetchConversation: async () => {
		throw new Error("not here");
	},
	inferKindFromId: () => "channel",
}));

beforeEach(() => {
	cached.clear();
});

/** A client whose search finds `found` and whose DMs open as D0DM0000001. */
function clientFinding(
	found: Record<string, { user?: string; channel?: string }>,
) {
	const queries: string[] = [];
	const client = {
		call: vi.fn(async (method: string, params: { query?: string }) => {
			if (method === "conversations.open") {
				return { channel: { id: "D0DM0000001" } };
			}
			if (method === "users.info") return { user: { name: "someone" } };
			if (method !== "search.messages") throw new Error(method);
			const query = params.query ?? "";
			queries.push(query);
			const hit = found[query];
			if (hit?.user) {
				return { messages: { matches: [{ user: hit.user, username: "h" }] } };
			}
			if (hit?.channel) {
				const channel = { id: hit.channel, name: "infra" };
				return { messages: { matches: [{ channel }] } };
			}
			return { messages: { matches: [] } };
		}),
	} as unknown as SlackClient;
	return { client, queries };
}

describe("a conversation named by a person", () => {
	it("opens the DM for a handle with a dot, without a channel search", async () => {
		const { client, queries } = clientFinding({
			"from:darren.worrall *": { user: "W0182UXLGUF" },
		});

		expect(await resolveConversation(client, "darren.worrall")).toMatchObject({
			id: "D0DM0000001",
			kind: "dm",
			dmUserId: "W0182UXLGUF",
		});
		expect(queries).toEqual(["from:darren.worrall *"]);
	});

	it("opens the DM for a bare handle no channel answers to", async () => {
		const { client } = clientFinding({
			"from:donks *": { user: "U0DONKS0001" },
		});

		expect(await resolveConversation(client, "donks")).toMatchObject({
			kind: "dm",
			dmUserId: "U0DONKS0001",
		});
	});

	it("still takes a bare name as a channel first", async () => {
		const { client } = clientFinding({
			"in:#infra *": { channel: "C0INFRA0001" },
		});

		expect(await resolveConversation(client, "infra")).toMatchObject({
			id: "C0INFRA0001",
			kind: "channel",
		});
	});

	it("never takes a #name for a person", async () => {
		const { client, queries } = clientFinding({
			"from:donks *": { user: "U0DONKS0001" },
		});

		await expect(resolveConversation(client, "#donks")).rejects.toThrow(
			/nothing by that name/,
		);
		expect(queries).toEqual(["in:#donks *"]);
	});
});
