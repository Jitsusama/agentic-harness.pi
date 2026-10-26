/**
 * A Slack call that the network never answers, or that Slack asks to wait.
 *
 * Either way a person is looking at a tool that has not come back. The
 * client owes them a clock on each request and a wait that ends when
 * they give up, rather than one that runs out the rate limit's full
 * sleep first.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackClient } from "../../../../lib/slack/api/client.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

/** A fetch that answers nothing until its request is aborted. */
function silentNetwork() {
	const fetch = vi.fn(
		(_url: string, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			}),
	);
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

describe("a Slack call", () => {
	it("fails on its own clock when the network never answers", async () => {
		silentNetwork();
		const client = new SlackClient("xoxp-1", undefined, {
			requestTimeoutMs: 200,
		});
		const started = Date.now();

		await expect(client.call("auth.test")).rejects.toMatchObject({
			name: "TimeoutError",
		});
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("says it was stopped, not that it ran out of time, when its signal fires", async () => {
		silentNetwork();
		const client = new SlackClient("xoxp-1");
		const stop = new AbortController();
		setTimeout(() => stop.abort(), 50);

		await expect(
			client.call("auth.test", {}, stop.signal),
		).rejects.toMatchObject({ name: "AbortError" });
	});

	it("stops waiting out a rate limit when its signal fires", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("", { status: 429, headers: { "Retry-After": "30" } }),
			),
		);
		const client = new SlackClient("xoxp-1");
		const stop = new AbortController();
		const started = Date.now();
		setTimeout(() => stop.abort(), 50);

		await expect(
			client.call("auth.test", {}, stop.signal),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(Date.now() - started).toBeLessThan(1000);
	});
});
