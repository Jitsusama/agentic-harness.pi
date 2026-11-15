/**
 * Naming the people a page of messages mentions: each one the cache
 * doesn't know is looked up once, and none once the caller gives up.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackClient } from "../../../../lib/slack/api/client.ts";
import { resolveUsersInMessages } from "../../../../lib/slack/api/resolve-users.ts";
import type { SlackMessage } from "../../../../lib/slack/types.ts";

// The cache lives under the real home directory, so the resolver reads
// and writes this map instead.
const names = new Map<string, string>();
vi.mock("../../../../lib/slack/resolvers/cache.ts", () => ({
	lookupId: () => null,
	lookupName: (_file: string, id: string) => names.get(id) ?? null,
	cacheMapping: (_file: string, name: string, id: string) => {
		names.set(id, name);
	},
}));

beforeEach(() => {
	names.clear();
});

/** A Slack that names every user it is asked about, noting each ask. */
function slack(): { client: SlackClient; asked: string[] } {
	const asked: string[] = [];
	const client = {
		call: vi.fn(async (_method: string, params: { user: string }) => {
			asked.push(params.user);
			return { user: { id: params.user, name: `h${params.user}` } };
		}),
	} as unknown as SlackClient;
	return { client, asked };
}

const said = (user: string, text = ""): SlackMessage => ({
	ts: "1.0",
	user,
	text,
});

describe("naming the people messages mention", () => {
	it("looks up each author and mention it doesn't know, once", async () => {
		names.set("U0KNOWN", "known");
		const { client, asked } = slack();

		await resolveUsersInMessages(client, [
			said("U1", "hi <@U2> and <@U0KNOWN>"),
			said("U2", "<@U1|someone>"),
		]);

		expect(asked.sort()).toEqual(["U1", "U2"]);
		expect(names.get("U1")).toBe("hU1");
		expect(names.get("U2")).toBe("hU2");
	});

	it("looks nobody up once its signal has fired", async () => {
		const { client, asked } = slack();
		const stop = new AbortController();
		stop.abort();

		await resolveUsersInMessages(client, [said("U1")], stop.signal);

		expect(asked).toEqual([]);
	});
});
