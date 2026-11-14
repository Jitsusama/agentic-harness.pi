/**
 * The soak's real-model slice: its provider passing each request on to a
 * real model rather than answering from the script. The script's mock
 * takes any conversation; a real API refuses one whose tool results don't
 * follow their calls or whose thinking was changed, which is how a host
 * that carried, parked or restored a conversation wrongly shows, so the
 * slice counts every refusal. The request goes on as pi sent it but for
 * the model, named here, and the soak's rules added to the system
 * prompt, which tell the model what each kind of turn asks of it, as the
 * mock's script does, so the script, its prompts and both sides stay as
 * they are. A real model's words differ run to run and side to side, so
 * a slice's records are compared by their shape: what each entry is, who
 * said it, how it stopped and which tools it called. The key comes from
 * the soak's own environment and goes only in the request's header to
 * the upstream, never to either side of the soak, a file or a log.
 */
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { isRecord } from "../../../lib/internal/record.ts";
import { JOB } from "./soak-provider.ts";

/** Where a slice's requests go on to, and as what. */
export interface Upstream {
	/** The Anthropic-messages base, such as `https://proxy.shopify.ai/apis/anthropic`. */
	readonly baseUrl: string;
	/** The key the upstream takes, sent as `x-api-key`. */
	readonly key: string;
	/** The model every request is sent on as. */
	readonly model: string;
}

/** One request the upstream refused, or that never reached it. */
export interface Refusal {
	/** The tag of the turn it was for, or nothing outside the script. */
	readonly tag: string | undefined;
	/** Its HTTP status, or 0 when the upstream was never reached. */
	readonly status: number;
	/** The start of what the upstream said, or the error that kept it from answering. */
	readonly said: string;
}

/** The AI proxy a slice's requests go to when none is named. */
const DEFAULT_PROXY = "https://proxy.shopify.ai";

/**
 * The proxies the key may be sent to: `https://` and a host under
 * shopify.ai, or a port on this machine's loopback, where a test stands
 * the script's own model in for the proxy; nothing else.
 */
const ALLOWED_PROXIES = [
	/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+shopify\.ai$/,
	/^http:\/\/127\.0\.0\.1:\d+$/,
];

/**
 * The Anthropic-messages base under the AI proxy at `origin`, as pi's
 * own managed provider routes it; an origin outside those allowed, unset
 * included, takes the default rather than carry the key elsewhere.
 */
export function proxyBaseOf(origin: string | undefined): string {
	const allowed =
		origin !== undefined && ALLOWED_PROXIES.some((one) => one.test(origin))
			? origin
			: DEFAULT_PROXY;
	return `${allowed}/apis/anthropic`;
}

/** How much of a refusal's words a report keeps. */
const REFUSAL_CHARACTERS = 500;

/** The headers a request takes on to the upstream from pi's, by lower-case name. */
const CARRIED_HEADERS = ["anthropic-version", "anthropic-beta", "accept"];

/** The system prompt's addition: what each soak turn asks of the model. */
export const SOAK_RULES = [
	"You are being soak-tested. Each message names a tag such as c3-t41 and",
	"a kind, as in 'soak c3-t41 echo, please'. Do exactly what the kind asks,",
	"say nothing else, and end your last answer of the turn with 'ack <tag>.'",
	"- echo, abort or anything else: answer 'heard, ack <tag>.'",
	"- read: call the read tool on notes.txt, then answer 'done, ack <tag>.'",
	"- bash: run 'echo soak bash <tag>' with the bash tool, then answer 'done, ack <tag>.'",
	`- job: run '${JOB}' with the bash tool in the background (background: true), then answer 'done, ack <tag>.'`,
	"- long: answer 119 lines reading 'line 1' to 'line 119', then a last line 'ack <tag>.'",
	"- steer: run 'echo soak steer <tag>' with the bash tool. When a message",
	"  'soak <tag> steered, please' comes, answer 'steered, ack <tag>.'",
	"Asked to summarise the conversation, summarise it briefly as asked.",
].join("\n");

/** The request pi sent, as it goes on: the slice's model, and the soak's rules after pi's system prompt. */
export function throughBody(
	body: Readonly<Record<string, unknown>>,
	model: string,
): Record<string, unknown> {
	const rules = { type: "text", text: SOAK_RULES };
	const { system } = body;
	const withRules =
		typeof system === "string"
			? [{ type: "text", text: system }, rules]
			: Array.isArray(system)
				? [...system, rules]
				: [rules];
	return { ...body, model, system: withRules };
}

/** The headers a request goes on with: pi's version and betas, and the upstream's key in place of the soak's. */
export function throughHeaders(
	incoming: IncomingHttpHeaders,
	key: string,
): Record<string, string> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"x-api-key": key,
	};
	for (const name of CARRIED_HEADERS) {
		const value = incoming[name];
		if (typeof value === "string") headers[name] = value;
	}
	return headers;
}

/**
 * Send `body` on to `upstream` and stream its answer back on `response`,
 * as it came, until the soak's side goes. Resolves with the refusal when
 * the upstream refused it or couldn't be reached, nothing otherwise.
 */
export async function passOn(
	body: Readonly<Record<string, unknown>>,
	incoming: IncomingHttpHeaders,
	upstream: Upstream,
	response: ServerResponse,
	tag: string | undefined,
): Promise<Refusal | undefined> {
	const gone = new AbortController();
	response.on("close", () => gone.abort());
	let answer: Response;
	try {
		answer = await fetch(`${upstream.baseUrl}/v1/messages`, {
			method: "POST",
			headers: throughHeaders(incoming, upstream.key),
			body: JSON.stringify(throughBody(body, upstream.model)),
			signal: gone.signal,
		});
	} catch (error) {
		if (gone.signal.aborted) return undefined;
		const said = error instanceof Error ? error.message : String(error);
		if (!response.headersSent) response.writeHead(502);
		response.end();
		return { tag, status: 0, said: said.slice(0, REFUSAL_CHARACTERS) };
	}
	response.writeHead(answer.status, {
		"content-type": answer.headers.get("content-type") ?? "text/event-stream",
	});
	if (!answer.ok) {
		const said = await answer.text();
		response.end(said);
		return {
			tag,
			status: answer.status,
			said: said.slice(0, REFUSAL_CHARACTERS),
		};
	}
	try {
		for await (const chunk of answer.body ?? []) {
			// The soak's side went mid-answer: an abort, which takes no more.
			if (response.destroyed) return undefined;
			response.write(chunk);
		}
	} catch (error) {
		// The fetch ends with an abort when the soak's side goes: no refusal.
		if (gone.signal.aborted) return undefined;
		throw error;
	}
	response.end();
	return undefined;
}

/** Tokens a slice's answers took, by how the upstream bills them. */
export interface Usage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

/** The ways a usage counts tokens, as pi records them. */
const USAGE_NAMES = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** The tokens every answer in `logs` took, as pi recorded each message's usage. */
export function usageOf(
	logs: readonly (readonly Readonly<Record<string, unknown>>[])[],
): Usage {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const entry of logs.flat()) {
		const usage = isRecord(entry.message) ? entry.message.usage : undefined;
		if (!isRecord(usage)) continue;
		for (const name of USAGE_NAMES) {
			const count = usage[name];
			if (typeof count === "number") total[name] += count;
		}
	}
	return total;
}

/**
 * An entry by its shape alone: its type, what kind of custom entry it
 * is, and for a message who said it, how it stopped, what its parts are
 * and which tools it called, without the words a real model chooses.
 */
export function shapeOf(
	entry: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const shape: Record<string, unknown> = { type: entry.type };
	if (typeof entry.customType === "string") shape.customType = entry.customType;
	const { message } = entry;
	if (!isRecord(message)) return shape;
	const parts = Array.isArray(message.content) ? message.content : [];
	return {
		...shape,
		role: message.role,
		...(message.stopReason === undefined
			? {}
			: { stopReason: message.stopReason }),
		...(typeof message.toolName === "string"
			? { toolName: message.toolName }
			: {}),
		parts: parts.map((part) =>
			isRecord(part)
				? part.type === "toolCall"
					? `toolCall:${String(part.name)}`
					: String(part.type)
				: typeof part,
		),
	};
}
