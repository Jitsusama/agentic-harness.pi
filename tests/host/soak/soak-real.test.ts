/**
 * The real-model slice's pass-through, against a local server standing
 * in for the AI proxy: what goes on, what comes back, what counts as a
 * refusal, and how its records compare by shape. No key and no model.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";
import { firstAskOf, soakProvider } from "./soak-provider.ts";
import {
	passOn,
	proxyBaseOf,
	type Refusal,
	SOAK_RULES,
	shapeOf,
	throughBody,
	throughHeaders,
	type Upstream,
	usageOf,
} from "./soak-real.ts";

/** What the stand-in proxy saw of one request. */
interface Seen {
	readonly headers: IncomingHttpHeaders;
	readonly body: unknown;
}

const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise((done) => server.close(done));
	}
});

/** Listen on a free port with `handler`, returning its base. */
async function listening(
	handler: Parameters<typeof createServer>[1],
): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("The stand-in has no port");
	return `http://127.0.0.1:${address.port}`;
}

/** A stand-in proxy answering every request with `status` and `body`, recording what it saw. */
async function proxy(
	status: number,
	body: string,
): Promise<{ readonly base: string; readonly seen: Seen[] }> {
	const seen: Seen[] = [];
	const base = await listening(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += String(chunk);
		seen.push({ headers: request.headers, body: JSON.parse(raw) });
		response.writeHead(status, { "content-type": "text/event-stream" });
		response.end(body);
	});
	return { base, seen };
}

/** The soak's side: every request passed on to `upstream`, each refusal kept. */
async function soakSide(
	upstream: Upstream,
): Promise<{ readonly base: string; readonly refusals: Refusal[] }> {
	const refusals: Refusal[] = [];
	const base = await listening(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += String(chunk);
		const refused = await passOn(
			JSON.parse(raw),
			request.headers,
			upstream,
			response,
			"c0-t1",
		);
		if (refused) refusals.push(refused);
	});
	return { base, refusals };
}

/** Ask the soak's side as pi would, with the soak's own stand-in key. */
function asked(base: string, signal?: AbortSignal): Promise<Response> {
	return fetch(`${base}/v1/messages`, {
		method: "POST",
		headers: {
			"x-api-key": "local-soak-no-secret",
			"anthropic-version": "2023-06-01",
			authorization: "Bearer local-soak-no-secret",
		},
		body: JSON.stringify({
			model: "mock",
			system: "pi's own",
			messages: [{ role: "user", content: "soak c0-t1 echo, please" }],
		}),
		signal,
	});
}

describe("a real-model request, as it goes on", () => {
	it("goes as the slice's model, with the soak's rules after pi's system prompt", () => {
		const messages = [{ role: "user", content: "soak c0-t1 echo, please" }];
		const rules = { type: "text", text: SOAK_RULES };
		expect(
			throughBody({ model: "mock", system: "pi's", messages }, "haiku"),
		).toEqual({
			model: "haiku",
			system: [{ type: "text", text: "pi's" }, rules],
			messages,
		});
		const cached = { type: "text", text: "pi's", cache_control: {} };
		expect(throughBody({ system: [cached] }, "haiku").system).toEqual([
			cached,
			rules,
		]);
		expect(throughBody({}, "haiku").system).toEqual([rules]);
	});

	it("carries pi's version and betas, and the upstream's key in place of the soak's", () => {
		expect(
			throughHeaders(
				{
					"x-api-key": "local-soak-no-secret",
					authorization: "Bearer local-soak-no-secret",
					"anthropic-version": "2023-06-01",
					"anthropic-beta": "fine-grained-tool-streaming",
					host: "127.0.0.1",
				},
				"the-key",
			),
		).toEqual({
			"content-type": "application/json",
			"x-api-key": "the-key",
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "fine-grained-tool-streaming",
		});
	});

	it("goes only to an AI proxy under shopify.ai, or a stand-in on this machine", () => {
		const base = "https://proxy.shopify.ai/apis/anthropic";
		expect(proxyBaseOf(undefined)).toBe(base);
		expect(proxyBaseOf("https://staging.proxy.shopify.ai")).toBe(
			"https://staging.proxy.shopify.ai/apis/anthropic",
		);
		expect(proxyBaseOf("https://shopify.ai.example.com")).toBe(base);
		expect(proxyBaseOf("http://proxy.shopify.ai")).toBe(base);
		expect(proxyBaseOf("http://127.0.0.1:4000")).toBe(
			"http://127.0.0.1:4000/apis/anthropic",
		);
		expect(proxyBaseOf("http://127.0.0.1.example.com:4000")).toBe(base);
	});
});

describe("a real-model answer, as it comes back", () => {
	it("streams the upstream's answer back as it came", async () => {
		const events = "event: message_stop\ndata: {}\n\n";
		const upstream = await proxy(200, events);
		const side = await soakSide({
			baseUrl: upstream.base,
			key: "the-key",
			model: "haiku",
		});
		const answer = await asked(side.base);
		expect(await answer.text()).toBe(events);
		expect(side.refusals).toEqual([]);
		const [seen] = upstream.seen;
		expect(seen?.headers["x-api-key"]).toBe("the-key");
		expect(seen?.headers.authorization).toBeUndefined();
		expect(isRecord(seen?.body) ? seen.body.model : undefined).toBe("haiku");
	});

	it("counts what the upstream refused, with the start of what it said", async () => {
		const said = '{"error":{"message":"tool_result without tool_use"}}';
		const upstream = await proxy(400, said);
		const side = await soakSide({
			baseUrl: upstream.base,
			key: "the-key",
			model: "haiku",
		});
		const answer = await asked(side.base);
		expect(answer.status, "pi sees the refusal as it came").toBe(400);
		expect(side.refusals).toEqual([{ tag: "c0-t1", status: 400, said }]);
	});

	it("counts an upstream it couldn't reach as a refusal of no status", async () => {
		const side = await soakSide({
			baseUrl: "http://127.0.0.1:1",
			key: "the-key",
			model: "haiku",
		});
		const answer = await asked(side.base);
		expect(answer.status).toBe(502);
		expect(side.refusals).toMatchObject([{ tag: "c0-t1", status: 0 }]);
	});

	it("lets the upstream go when pi aborts, counting nothing", async () => {
		let upstreamGone = () => {};
		const gone = new Promise<void>((done) => {
			upstreamGone = done;
		});
		const base = await listening((request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write("event: ping\ndata: {}\n\n");
			request.on("close", upstreamGone);
		});
		const side = await soakSide({
			baseUrl: base,
			key: "the-key",
			model: "haiku",
		});
		const abort = new AbortController();
		const answer = await asked(side.base, abort.signal);
		const reader = answer.body?.getReader();
		await reader?.read();
		abort.abort();
		await gone;
		expect(side.refusals).toEqual([]);
	});
});

describe("the soak's provider, passing requests on", () => {
	const request = (messages: unknown[]) => ({
		method: "POST",
		body: JSON.stringify({ model: "mock", messages }),
	});
	const prompt = { role: "user", content: "soak c0-t3 bash, please" };
	const called = {
		role: "assistant",
		content: [{ type: "tool_use", id: "t", name: "bash", input: {} }],
	};
	const result = {
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }],
	};

	it("holds a turn at its first request, since a real model's rounds aren't the script's", () => {
		expect(firstAskOf([prompt])).toBe("c0-t3");
		expect(firstAskOf([prompt, called, result]), "a later round").toBe(
			undefined,
		);
		expect(
			firstAskOf([
				prompt,
				{ role: "user", content: "soak c0-t3 steered, please" },
			]),
			"a steer's",
		).toBe(undefined);
		expect(
			firstAskOf([
				{ role: "user", content: "/compact soak c0-t4 compact, please" },
			]),
			"a compaction's",
		).toBe(undefined);
	});

	it("answers nothing itself, passing each request on with its turn's tag, and holds its first", async () => {
		const tags: (string | undefined)[] = [];
		const provider = await soakProvider(
			{},
			async (_body, _headers, response, tag) => {
				tags.push(tag);
				response.writeHead(200);
				response.end("passed");
			},
		);
		try {
			provider.hold("c0-t3");
			const first = fetch(
				`${provider.endpoint}/v1/messages`,
				request([prompt]),
			);
			await provider.held("c0-t3", 5000);
			expect(tags, "nothing passed on while held").toEqual([]);
			provider.release("c0-t3");
			expect(await (await first).text()).toBe("passed");
			await fetch(
				`${provider.endpoint}/v1/messages`,
				request([prompt, called, result]),
			);
			expect(tags).toEqual(["c0-t3", "c0-t3"]);
		} finally {
			await provider.close();
		}
	});
});

describe("a real-model slice's records", () => {
	const answer = (text: string, stopReason = "stop") => ({
		type: "message",
		id: "a",
		message: {
			role: "assistant",
			stopReason,
			content: [
				{ type: "thinking", thinking: text },
				{ type: "toolCall", name: "bash", arguments: { command: text } },
			],
			usage: { input: 10, output: 3, cacheRead: 100, cacheWrite: 7 },
		},
	});

	it("compare by shape, not the words a model chooses", () => {
		expect(shapeOf(answer("one way"))).toEqual(shapeOf(answer("another")));
		expect(shapeOf(answer("one way"))).toEqual({
			type: "message",
			role: "assistant",
			stopReason: "stop",
			parts: ["thinking", "toolCall:bash"],
		});
		expect(
			shapeOf(answer("x", "aborted")),
			"how it stopped counts",
		).not.toEqual(shapeOf(answer("x")));
		expect(
			shapeOf({ type: "custom", customType: "journal", data: { a: 1 } }),
		).toEqual({ type: "custom", customType: "journal" });
	});

	it("say how many tokens every answer took", () => {
		expect(usageOf([[answer("a"), { type: "custom" }], [answer("b")]])).toEqual(
			{
				input: 20,
				output: 6,
				cacheRead: 200,
				cacheWrite: 14,
			},
		);
	});
});
