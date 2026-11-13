/**
 * The soak's model: a local Anthropic-messages endpoint, as the parity
 * suite's is, answering every request from the soak's script without end,
 * so pi's real provider code serialises and parses each turn the host and
 * plain pi take. It answers by the latest soak prompt in the request: a
 * tool's result is acknowledged, a read reads `notes.txt`, a bash turn
 * echoes, a job runs bash in the background, a long turn answers in 120
 * lines, and anything else is echoed. Every turn's last answer ends in
 * the prompt's tag, which the soak waits for. Given a pace, each answer
 * takes a time drawn from it, its words arriving in pieces across that
 * time, each bash command waits a drawn time before it echoes, and a turn
 * has a drawn count of rounds, each before its own answer a tool call,
 * two bash to a read, as a real turn works before it answers. Without one
 * it answers at once, in one piece, bash echoes at once, and a turn is
 * only its own answer. It binds 127.0.0.1 and takes no credential.
 */
import { createServer, type ServerResponse } from "node:http";
import { setTimeout as later } from "node:timers/promises";
import { isRecord } from "../../../lib/internal/record.ts";
import {
	drawn,
	MOST_ROUNDS,
	PIECE_EVERY_MS,
	type Percentiles,
	piecesOf,
} from "./pace.ts";
import { acknowledged, asked, type Turn, type TurnKind } from "./turns.ts";

/** How long answers and tools take and how many rounds a turn has. */
export interface SoakPace {
	/** How long the model takes over each answer, in ms. */
	readonly answer?: Percentiles;
	/** How long each bash command runs, in ms. */
	readonly tool?: Percentiles;
	/** How many rounds a turn has, the model answering once in each. */
	readonly rounds?: Percentiles;
}

/** The turn kinds whose own answer is a tool call, so two rounds. */
const TOOL_KINDS: ReadonlySet<TurnKind> = new Set(["read", "bash", "job"]);

/** Of each three rounds before a turn's own, the one that reads. */
const READS_EVERY = 3;

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

/** Listen on a free local port, answering at `pace`. */
export async function soakProvider(pace: SoakPace = {}): Promise<SoakProvider> {
	let answered = 0;
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += String(chunk);
		const body: unknown = JSON.parse(raw);
		const messages: unknown = isRecord(body) ? body.messages : undefined;
		answered += 1;
		const history = Array.isArray(messages) ? messages : [];
		await stream(
			response,
			answerTo(history, pace),
			answered,
			pace.answer === undefined ? 0 : drawn(pace.answer, drawKeyOf(history)),
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

/** What the request whose messages are `messages` is answered with, at `pace`. */
export function answerTo(
	messages: readonly unknown[],
	pace: SoakPace = {},
): Block {
	const sofar = turnSoFar(messages);
	if (sofar === undefined) return { type: "text", text: UNSCRIPTED };
	const { turn, round } = sofar;
	const runsMs = (key: string) =>
		pace.tool === undefined ? 0 : drawn(pace.tool, `${turn.tag} tool ${key}`);
	const before = roundsBefore(turn, pace.rounds);
	if (round < before) return workFor(turn.tag, round, runsMs(`${round}`));
	const ack = acknowledged(turn.tag);
	if (round > before) return { type: "text", text: `done, ${ack}` };
	return blockFor(turn.kind, turn.tag, ack, runsMs("own"));
}

/** The soak turn `messages` are of, and how many of its tools have answered. */
function turnSoFar(
	messages: readonly unknown[],
): { readonly turn: Pick<Turn, "tag" | "kind">; readonly round: number } | undefined {
	let start = messages.length - 1;
	while (start >= 0 && !said(messages[start])) start -= 1;
	const turn = start < 0 ? undefined : asked(textOf(messages[start]));
	if (turn === undefined) return undefined;
	const round = messages.slice(start + 1).filter(isToolResult).length;
	return { turn, round };
}

/** How many rounds of work come before `turn`'s own answer, at `rounds`. */
function roundsBefore(
	turn: Pick<Turn, "tag" | "kind">,
	rounds: Percentiles | undefined,
): number {
	if (rounds === undefined) return 0;
	const total = drawn(rounds, `${turn.tag} rounds`, MOST_ROUNDS);
	return Math.max(0, total - (TOOL_KINDS.has(turn.kind) ? 2 : 1));
}

/** Round `round` of a turn's work: two bash, then a read, over again. */
function workFor(tag: string, round: number, runsMs: number): Block {
	if (round % READS_EVERY === READS_EVERY - 1)
		return { type: "tool_use", name: "read", input: { path: "notes.txt" } };
	return {
		type: "tool_use",
		name: "bash",
		input: { command: `${waitFor(runsMs)}echo soak round ${round} ${tag}` },
	};
}

/**
 * What a request's time is drawn by: the turn it answers and its round,
 * the same on either side of the soak.
 */
function drawKeyOf(messages: readonly unknown[]): string {
	const sofar = turnSoFar(messages);
	if (sofar === undefined) return UNSCRIPTED;
	return `${sofar.turn.tag} answer ${sofar.round}`;
}

function blockFor(
	kind: TurnKind,
	tag: string,
	ack: string,
	runsMs: number,
): Block {
	switch (kind) {
		case "read":
			return { type: "tool_use", name: "read", input: { path: "notes.txt" } };
		case "bash":
			return {
				type: "tool_use",
				name: "bash",
				input: { command: `${waitFor(runsMs)}echo soak bash ${tag}` },
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

/** A command's wait of `ms` before it goes on, or none for no time. */
function waitFor(ms: number): string {
	return ms === 0 ? "" : `sleep ${(ms / MS_PER_SECOND).toFixed(3)}; `;
}

const MS_PER_SECOND = 1000;

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

/**
 * Stream `block` as Anthropic's server-sent events, as answer `count`,
 * its words in pieces spread across `takesMs`.
 */
async function stream(
	response: ServerResponse,
	block: Block,
	count: number,
	takesMs: number,
): Promise<void> {
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
	const words = tool ? JSON.stringify(block.input) : block.text;
	const pieces = piecesOf(words, Math.floor(takesMs / PIECE_EVERY_MS));
	const gapMs = takesMs / pieces.length;
	for (const piece of pieces) {
		if (gapMs > 0) await later(gapMs);
		// A client that went away while the answer streamed takes no more.
		if (response.destroyed) return;
		emit({
			type: "content_block_delta",
			index: 0,
			delta: tool
				? { type: "input_json_delta", partial_json: piece }
				: { type: "text_delta", text: piece },
		});
	}
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
