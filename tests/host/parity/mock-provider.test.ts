import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { deadline, mockProvider } from "./mock-provider.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function requestsFile(): string {
	const root = mkdtempSync(join(tmpdir(), "parity-mock-"));
	roots.push(root);
	return join(root, "requests.ndjson");
}

function send(endpoint: string, body: object): Promise<Response> {
	return fetch(`${endpoint}/v1/messages`, {
		method: "POST",
		body: JSON.stringify(body),
	});
}

it("answers over real HTTP and records what it was sent", async () => {
	const mock = await mockProvider(requestsFile(), "plain");
	try {
		const response = await send(mock.endpoint, {
			messages: [],
			tools: [{ name: "read" }],
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('"type":"message_stop"');
		expect(mock.requests.at(0)?.tools).toEqual([{ name: "read" }]);
	} finally {
		await mock.close();
	}
});

it("holds the steer scenario's first request until released", async () => {
	const mock = await mockProvider(requestsFile(), "steer");
	try {
		const response = send(mock.endpoint, { messages: [], tools: [] });
		await mock.held();
		mock.release();
		expect(await (await response).text()).toContain('"name":"read"');
	} finally {
		await mock.close();
	}
});

it("refuses a wait whose condition never comes", async () => {
	await expect(
		deadline(new Promise(() => {}), 10, "The request did not arrive"),
	).rejects.toThrow("The request did not arrive");
});
