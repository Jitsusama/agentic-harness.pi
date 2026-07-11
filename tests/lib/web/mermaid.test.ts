import { describe, expect, it } from "vitest";
import {
	loadMermaidSource,
	MermaidRenderError,
} from "../../../lib/web/mermaid.js";

describe("loadMermaidSource error mapping", () => {
	it("maps a rejected fetch to a network MermaidRenderError", async () => {
		const rejecting = (() =>
			Promise.reject(new Error("offline"))) as unknown as typeof fetch;

		await expect(loadMermaidSource(rejecting)).rejects.toThrow(
			MermaidRenderError,
		);
		await expect(loadMermaidSource(rejecting)).rejects.toThrow(/network/i);
	});

	it("names the HTTP status when the response is not ok", async () => {
		const notOk = (() =>
			Promise.resolve({ ok: false, status: 503 })) as unknown as typeof fetch;

		await expect(loadMermaidSource(notOk)).rejects.toThrow(/HTTP 503/);
	});
});
