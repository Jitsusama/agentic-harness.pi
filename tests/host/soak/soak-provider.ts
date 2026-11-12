/**
 * The soak's model: a local Anthropic-messages endpoint, as the parity
 * suite's is, answering every request from the soak's script without end,
 * so pi's real provider code serialises and parses each turn the host and
 * plain pi take. It answers by the latest soak prompt in the request: a
 * tool's result is acknowledged, a read reads `notes.txt`, a bash turn
 * echoes, a job runs bash in the background, a long turn answers in 120
 * lines, and anything else is echoed. Every turn's last answer ends in
 * the prompt's tag, which the soak waits for. It binds 127.0.0.1 and takes
 * no credential.
 */
import { createServer, type ServerResponse } from "node:http";
import { isRecord } from "../../../lib/internal/record.ts";
import { acknowledged, asked, type TurnKind } from "./turns.ts";

/** The provider, while it listens. */
export interface SoakProvider {
	readonly endpoint: string;
	/** How many requests it has answered. */
	answered(): number;
	close(): Promise<void>;
}

/** What a job's command prints once its moment's wait is over. */
export const JOB_SAYS = "soak job done";

/** What a job turn has bash run in the background: a moment's wait, then words. */
export const JOB = `timeout 1 tail -f /dev/null; echo ${JOB_SAYS}`;

/** How many lines a long answer has. */
const LONG_LINES = 120;

/** What a request with no soak prompt in it is answered with. */
const UNSCRIPTED = "soak mock";

/** One content block of a streamed answer. */
type Block =
	| { readonly type: "text"; readonly text: string }
	| {
			readonly type: "tool_use";
			readonly name: string;
			readonly input: Readonly<Record<string, unknown>>;
	  };

/** Listen on a free local port. */
export async function soakProvider(): Promise<SoakProvider> {
	let answered = 0;
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += String(chunk);
		const body: unknown = JSON.parse(raw);
		const messages: unknown = isRecord(body) ? body.messages : undefined;
		answered += 1;
		stream(
			response,
			answerTo(Array.isArray(messages) ? messages : []),
			answered,
		);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("The soak provider has no port");
	return {
		endpoint: `http://127.0.0.1:${address.port}`,
		answered: () => answered,
		close: async () => {
			server.closeAllConnections();
			await new Promise((done) => server.close(done));
		},
	};
}

/** What the request whose messages are `messages` is answered with. */
export function answerTo(messages: readonly unknown[]): Block {
	const prompt = [...messages].reverse().find(said);
	const turn = prompt === undefined ? undefined : asked(textOf(prompt));
	if (turn === undefined) return { type: "text", text: UNSCRIPTED };
	const ack = acknowledged(turn.tag);
	if (isToolResult(messages.at(-1)))
		return { type: "text", text: `done, ${ack}` };
	return blockFor(turn.kind, turn.tag, ack);
}

function blockFor(kind: TurnKind, tag: string, ack: string): Block {
	switch (kind) {
		case "read":
			return { type: "tool_use", name: "read", input: { path: "notes.txt" } };
		case "bash":
			return {
				type: "tool_use",
				name: "bash",
				input: { command: `echo soak bash ${tag}` },
			};
		case "job":
			return {
				type: "tool_use",
				name: "bash",
				input: { command: JOB, background: true },
			};
		case "long":
			return {
				type: "text",
				text: [
					...Array.from({ length: LONG_LINES - 1 }, (_, n) => `line ${n + 1}`),
					ack,
				].join("\n"),
			};
		case "echo":
			return { type: "text", text: `heard, ${ack}` };
	}
}

/** Whether a message is one the person said, rather than a tool's result. */
function said(message: unknown): boolean {
	return isRecord(message) && message.role === "user" && !isToolResult(message);
}

/** Whether a message carries a tool's result, as Anthropic's API sends one. */
function isToolResult(message: unknown): boolean {
	const content = isRecord(message) ? message.content : undefined;
	return (
		Array.isArray(content) &&
		content.some((part) => isRecord(part) && part.type === "tool_result")
	);
}

/** A message's words: its content, or the text of its parts joined. */
export function textOf(message: unknown): string {
	const content = isRecord(message) ? message.content : undefined;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			isRecord(part) && typeof part.text === "string" ? part.text : "",
		)
		.join("");
}

/** Stream `block` as Anthropic's server-sent events, as answer `count`. */
function stream(response: ServerResponse, block: Block, count: number): void {
	const tool = block.type === "tool_use";
	response.writeHead(200, { "content-type": "text/event-stream" });
	const emit = (data: { type: string } & Record<string, unknown>) =>
		response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
	emit({
		type: "message_start",
		message: {
			id: `msg_soak_${count}`,
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
	emit({
		type: "content_block_start",
		index: 0,
		content_block: tool
			? {
					type: "tool_use",
					id: `call_soak_${count}`,
					name: block.name,
					input: {},
				}
			: { type: "text", text: "" },
	});
	emit({
		type: "content_block_delta",
		index: 0,
		delta: tool
			? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
			: { type: "text_delta", text: block.text },
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
