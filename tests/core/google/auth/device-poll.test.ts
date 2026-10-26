/**
 * Waiting for the person to approve a device code.
 *
 * The wait is minutes long by design, so the property that matters is
 * that giving up ends it at once, and that an answer which will never
 * change is not asked again every few seconds until the code expires.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { pollForDeviceAuthorization } from "../../../../lib/core/google/auth/oauth.ts";

const CONFIG = { clientId: "id", clientSecret: "secret" };

function answering(...bodies: { status: number; body: unknown }[]) {
	const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
		if (init?.signal?.aborted) throw init.signal.reason;
		const next = bodies.shift() ?? {
			status: 400,
			body: { error: "authorization_pending" },
		};
		return new Response(JSON.stringify(next.body), { status: next.status });
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("polling for a device code's approval", () => {
	it("returns the credentials once the person approves", async () => {
		answering(
			{ status: 400, body: { error: "authorization_pending" } },
			{
				status: 200,
				body: {
					access_token: "at",
					refresh_token: "rt",
					expires_in: 60,
					token_type: "Bearer",
					scope: "s",
				},
			},
		);
		const credentials = await pollForDeviceAuthorization(CONFIG, "dc", 0.01);
		expect(credentials.access_token).toBe("at");
	});

	it("stops within moments of its signal, not at the next poll", async () => {
		const fetch = answering();
		const stop = new AbortController();
		const started = Date.now();
		const waiting = pollForDeviceAuthorization(CONFIG, "dc", 5, stop.signal);
		setTimeout(() => stop.abort(), 50);

		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
		expect(Date.now() - started).toBeLessThan(1000);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("gives up on a refusal that will not change instead of asking again", async () => {
		const fetch = answering({
			status: 400,
			body: { error: "invalid_client", error_description: "bad client" },
		});
		await expect(
			pollForDeviceAuthorization(CONFIG, "dc", 0.01),
		).rejects.toThrow("bad client");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
