/**
 * A local Anthropic-messages endpoint that answers each parity scenario from
 * a script and records every request, so pi's real provider code serialises
 * and parses each turn. It binds 127.0.0.1 and takes no credential. In the
 * steer and abort scenarios it holds the first request until released, so a
 * steer or abort lands while the provider is answering.
 */
import { appendFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";

/** The six scenarios the parity test records on each side. */
export const SCENARIOS = [
	"plain",
	"tool",
	"steer",
	"abort",
	"compaction",
	"command",
] as const;

/** One of the parity scenarios. */
export type Scenario = (typeof SCENARIOS)[number];

/** A request the provider was sent, as its JSON body. */
export type ProviderRequest = Readonly<Record<string, unknown>>;

/** The scripted provider, while it listens. */
export interface MockProvider {
	readonly endpoint: string;
	readonly requests: readonly ProviderRequest[];
	/** Resolves once the held request has arrived. */
	held(): Promise<void>;
	/** Let the held request be answered. */
	release(): void;
	close(): Promise<void>;
}

/** How long a held request may take to arrive. */
const ARRIVAL_DEADLINE_MS = 120_000;

/** What the compaction scenario's summary request is answered with. */
const SUMMARY = [
	"## Goal",
	"Remember parity fixture.",
	"## Progress",
	"Fixture recorded.",
	"## Next Steps",
	"Continue parity.",
].join("\n");

/** Listen on a free local port, answering `scenario`'s script and appending each request to `requestsFile`. */
export async function mockProvider(
	requestsFile: string,
	scenario: Scenario,
): Promise<MockProvider> {
	const requests: ProviderRequest[] = [];
	const holds = scenario === "steer" || scenario === "abort";
	let arrived = () => {};
	const arrival = new Promise<void>((done) => {
		arrived = done;
	});
	let release = () => {};
	const released = new Promise<void>((done) => {
		release = done;
	});
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += String(chunk);
		const body: unknown = JSON.parse(raw);
		const recorded: ProviderRequest =
			body !== null && typeof body === "object" ? { ...body } : {};
		const index = requests.length;
		requests.push(recorded);
		appendFileSync(
			requestsFile,
			`${JSON.stringify({ path: request.url, body: recorded })}\n`,
		);
		appendFileSync(
			`${requestsFile}.headers`,
			`${JSON.stringify({ path: request.url, headers: request.headers })}\n`,
		);
		if (holds && index === 0) {
			arrived();
			await Promise.race([
				released,
				new Promise((done) => response.on("close", done)),
			]);
		}
		if (response.destroyed) return;
		answer(response, scenario, index);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("The mock provider has no port");
	return {
		endpoint: `http://127.0.0.1:${address.port}`,
		requests,
		held: () =>
			deadline(
				arrival,
				ARRIVAL_DEADLINE_MS,
				"The provider's first request did not arrive",
			),
		release: () => release(),
		close: async () => {
			release();
			server.closeAllConnections();
			await new Promise((done) => server.close(done));
		},
	};
}

/** Stream the scripted answer to request `index` as Anthropic's server-sent events. */
function answer(
	response: ServerResponse,
	scenario: Scenario,
	index: number,
): void {
	const tool = (scenario === "tool" || scenario === "steer") && index === 0;
	const text =
		scenario === "compaction" && index === 1 ? SUMMARY : "Parity answer.";
	response.writeHead(200, { "content-type": "text/event-stream" });
	const emit = (data: { type: string } & Record<string, unknown>) =>
		response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
	emit({
		type: "message_start",
		message: {
			id: `msg_parity_${index}`,
			type: "message",
			role: "assistant",
			model: "mock",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: {
				input_tokens: 100,
				output_tokens: 0,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
			},
		},
	});
	const input = { path: "fixture.txt" };
	emit({
		type: "content_block_start",
		index: 0,
		content_block: tool
			? { type: "tool_use", id: "call_parity_1", name: "read", input: {} }
			: { type: "text", text: "" },
	});
	emit({
		type: "content_block_delta",
		index: 0,
		delta: tool
			? { type: "input_json_delta", partial_json: JSON.stringify(input) }
			: { type: "text_delta", text },
	});
	emit({ type: "content_block_stop", index: 0 });
	emit({
		type: "message_delta",
		delta: {
			stop_reason: tool ? "tool_use" : "end_turn",
			stop_sequence: null,
		},
		usage: { output_tokens: 10 },
	});
	emit({ type: "message_stop" });
	response.end();
}

/** `promise`, or a refusal saying `what` once `ms` pass first. */
export function deadline<T>(
	promise: Promise<T>,
	ms: number,
	what: string,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<never>((_done, refuse) => {
		timer = setTimeout(() => refuse(new Error(what)), ms);
	});
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
