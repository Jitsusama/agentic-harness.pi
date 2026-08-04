/**
 * Naming a person to Slack.
 *
 * The resolver took a user ID or a handle, and resolved a handle by
 * searching for a message from it. A full name with a space in it
 * therefore became `from:Chao Duan *`, which matches nothing and failed
 * with advice to use a user ID: the one form a person asking about a
 * colleague does not have.
 *
 * An email is the form that can actually be looked up, and nothing tried
 * it. The module's own comment says enterprise grids block
 * `users.lookupByEmail` alongside `users.list`, so the attempt has to
 * degrade to a refusal rather than fail loudly, and the refusal has to
 * name what does work.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackClient } from "../../../lib/slack/index.js";
import { resolveUser } from "../../../lib/slack/resolvers/user.js";

// The cache lives under the real home directory and its path is fixed when
// the module loads, so without this the resolver answers from whatever the
// developer happened to look up last. One of these tests passed against a
// stranger's id before this was here.
const cached = new Map<string, string>();
vi.mock("../../../lib/slack/resolvers/cache.js", () => ({
	lookupId: (_file: string, name: string) => cached.get(name),
	lookupName: () => undefined,
	listCached: () => [],
	cacheMapping: (_file: string, name: string, id: string) => {
		cached.set(name, id);
	},
}));

beforeEach(() => {
	cached.clear();
});

/** A client that answers the named methods and refuses the rest. */
function clientWith(
	answers: Record<string, unknown>,
	failures: Record<string, string> = {},
): { client: SlackClient; called: string[] } {
	const called: string[] = [];
	const client = {
		call: vi.fn(async (method: string) => {
			called.push(method);
			const failure = failures[method];
			if (failure) throw new Error(failure);
			return answers[method] ?? {};
		}),
	} as unknown as SlackClient;
	return { client, called };
}

describe("resolving a person to a Slack id", () => {
	it("takes a user ID as given", async () => {
		const { client, called } = clientWith({});

		expect(await resolveUser(client, "U0123ABCD")).toBe("U0123ABCD");
		expect(called).toEqual([]);
	});

	it("looks an email up by email, which is the form that resolves", async () => {
		const { client, called } = clientWith({
			"users.lookupByEmail": { user: { id: "U9999ZZZZ", name: "joel.gerber" } },
		});

		expect(await resolveUser(client, "joel.gerber@shopify.com")).toBe(
			"U9999ZZZZ",
		);
		expect(called).toContain("users.lookupByEmail");
	});

	it("falls back to search when the grid blocks the email lookup", async () => {
		// Blocked is the expected answer on an enterprise grid, so it must not
		// become the caller's error.
		const { client, called } = clientWith(
			{
				"search.messages": {
					messages: {
						matches: [{ user: "U4444DDDD", username: "joel.gerber" }],
					},
				},
			},
			{ "users.lookupByEmail": "missing_scope" },
		);

		expect(await resolveUser(client, "joel.gerber@shopify.com")).toBe(
			"U4444DDDD",
		);
		expect(called).toContain("search.messages");
	});

	it("refuses a full name by naming the forms that work", async () => {
		// `from:Chao Duan *` cannot match, so searching is not worth the call.
		const { client, called } = clientWith({});

		await expect(resolveUser(client, "Chao Duan")).rejects.toThrow(
			/email address/i,
		);
		expect(called).toEqual([]);
	});

	it("still resolves a plain handle through search", async () => {
		const { client } = clientWith({
			"search.messages": {
				messages: { matches: [{ user: "U5555EEEE", username: "chao.duan" }] },
			},
		});

		expect(await resolveUser(client, "@chao.duan")).toBe("U5555EEEE");
	});
});
