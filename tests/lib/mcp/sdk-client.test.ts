import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSdkClient } from "../../../lib/mcp/sdk-client.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("buildSdkClient", () => {
	it("sends to the server's url with its headers and its bearer token", async () => {
		const sent: { url?: string; headers?: Headers } = {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: unknown, init?: RequestInit) => {
				sent.url = String(url);
				sent.headers = new Headers(init?.headers);
				return new Response(null, { status: 202 });
			}),
		);
		const { transport } = buildSdkClient({
			id: "gw",
			url: "https://example/mcp",
			authToken: "t0k",
			headers: { "X-Feature": "on" },
		});
		await transport.start();
		await transport.send({
			jsonrpc: "2.0",
			method: "notifications/initialized",
		});
		expect(sent.url).toBe("https://example/mcp");
		expect(sent.headers?.get("authorization")).toBe("Bearer t0k");
		expect(sent.headers?.get("x-feature")).toBe("on");
	});

	it("sends no authorization header without a token", async () => {
		const sent: { headers?: Headers } = {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init?: RequestInit) => {
				sent.headers = new Headers(init?.headers);
				return new Response(null, { status: 202 });
			}),
		);
		const { transport } = buildSdkClient({
			id: "gw",
			url: "https://example/mcp",
		});
		await transport.start();
		await transport.send({
			jsonrpc: "2.0",
			method: "notifications/initialized",
		});
		expect(sent.headers?.has("authorization")).toBe(false);
	});
});
