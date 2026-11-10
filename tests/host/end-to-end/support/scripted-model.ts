/**
 * The scripted model every E check runs on, whichever pi serves it: the
 * host's engine registers it in the host's process, and a plain pi
 * opening a hosted conversation's log registers it through
 * scripted-provider.ts. Both take pi-ai's faux provider from the pi
 * built with the host's patches, under one fixed api, so the seal's
 * models.json names it for both.
 *
 * The model reads each turn's transcript rather than playing a fixed
 * list, since one provider answers every conversation a host holds and
 * their turns interleave as the mesh delivers:
 *
 * - told `ping <address>`, it asks that peer `ping` over the mesh;
 * - handed a mesh question saying `ping`, it answers `pong` to it;
 * - handed `pong`, it says `pong heard`;
 * - told `store`, it loads spend, which is deferred, through tool_search,
 *   then asks it for fifty rows, two shown, so the rest are stored under
 *   a handle;
 * - told `query <handle>`, it asks result_query for every stored row;
 * - told `account`, it has bash print what the conversation is billed
 *   and credited as, then commit once and print the commit's message;
 * - told `load <quest>`, it loads that quest;
 * - told `spawn <quest>`, it spawns that quest's session into the
 *   realm's attended host;
 * - told `end <address>`, it loads mesh_end, which is deferred, through
 *   tool_search, then ends that peer;
 * - after any other tool's result, it says `sent`.
 *
 * A host process and a plain pi import this by path, under node's own
 * type stripping, so it holds nothing node can't strip.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

/** The api the scripted provider answers under, in every pi. */
export const SCRIPTED_API = "sealed-faux";

/** The scripted provider and model a conversation is opened on. */
export const SCRIPTED = { provider: "sealed-faux", id: "faux-1" } as const;

/** A second model of the same provider, answering the same way. */
export const SCRIPTED_TOO = { provider: "sealed-faux", id: "faux-2" } as const;

/** Where the scripted provider says it is, which nothing ever reaches. */
export const SCRIPTED_URL = "http://faux.invalid";

/** The models the scripted provider serves, as models.json lists them. */
export const SCRIPTED_MODELS: ProviderModelConfig[] = [
	SCRIPTED,
	SCRIPTED_TOO,
].map((model) => ({
	id: model.id,
	name: "Scripted",
	reasoning: false,
	input: ["text"],
	contextWindow: 128_000,
	maxTokens: 16_384,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}));

/** What a conversation is told to store rows under a handle. */
export const STORE = "store";

/** What a conversation is told to say what it is billed and credited as. */
export const ACCOUNT = "account";

/** How many answers the scripted model has in it, more than any check asks. */
const ANSWERS = 200;

/** How many characters each streamed token holds. */
export const TOKEN_SIZE = { min: 2, max: 2 } as const;

/** Fifty rows from SQLite alone, whatever the ledger holds. */
const FIFTY_ROWS = `SELECT value FROM json_each('${JSON.stringify(
	Array.from({ length: 50 }, (_, at) => at + 1),
)}')`;

/**
 * What bash runs for `account`: the budget and its variable, the
 * session, and the commit credit, then a commit in the conversation's
 * repository and the message it was given.
 */
const ACCOUNTING = [
	"env | grep -E '^(PI_BUDGET|E3_KEY|PI_SESSION_ID|PI_CO_AUTHOR)=' | sort",
	"git commit --quiet --allow-empty -m 'test(e3): credit this model'",
	"git log -1 --format=%B",
].join("; ");

/** What the scripted model uses of pi-ai's faux provider. */
export interface Faux {
	createFauxCore(options: object): FauxCore;
	fauxAssistantMessage(content: unknown, options?: object): unknown;
	fauxToolCall(name: string, args: object, options?: { id?: string }): unknown;
}

/** A faux provider's core: its streams, and the answers it gives. */
export interface FauxCore {
	readonly api: string;
	readonly stream: unknown;
	readonly streamSimple: NonNullable<ProviderConfig["streamSimple"]>;
	setResponses(responses: readonly unknown[]): void;
}

/** One message of a transcript, as the provider is handed it. */
interface Said {
	readonly role: string;
	readonly content?: unknown;
	readonly toolName?: string;
}

/** A pi module as this uses it: pi's JavaScript carries no types here. */
function piModule<T>(module: unknown): T {
	return module as T;
}

/** pi-ai's faux provider, from the pi `packageDir` names. */
export async function fauxOf(packageDir: string): Promise<Faux> {
	return piModule<Faux>(
		await import(
			pathToFileURL(
				join(
					packageDir,
					"node_modules/@earendil-works/pi-ai/dist/providers/faux.js",
				),
			).href
		),
	);
}

/** The scripted model's core, under its api, answering as it says above. */
export function scriptedCore(faux: Faux): FauxCore {
	const core = faux.createFauxCore({
		api: SCRIPTED_API,
		provider: SCRIPTED.provider,
		models: SCRIPTED_MODELS,
		tokenSize: TOKEN_SIZE,
	});
	core.setResponses(
		Array.from(
			{ length: ANSWERS },
			() => (context: { messages: readonly Said[] }) =>
				answer(faux, context.messages),
		),
	);
	return core;
}

/** A message's words, whatever shape its content takes. */
function wordsOf(message: Said | undefined): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: { type?: string; text?: string }) =>
			part.type === "text" ? (part.text ?? "") : "",
		)
		.join("");
}

/** What `end <address>` says, naming the peer to end. */
const ENDING = /^end ([0-9A-Z]+)$/m;

/** Whether `words` hold `told` as a line of its own. */
function toldTo(words: string, told: string): boolean {
	return new RegExp(`^${told}$`, "m").test(words);
}

/** The scripted model's answer to a transcript. */
function answer(faux: Faux, messages: readonly Said[]): unknown {
	const last = messages.at(-1);
	if (last?.role === "toolResult") {
		const told = wordsOf(
			[...messages].reverse().find((one) => one.role === "user"),
		);
		const ending = ENDING.exec(told)?.[1];
		if (last.toolName === "tool_search" && toldTo(told, STORE))
			return toolCall(faux, "spend", { query: FIFTY_ROWS, limit: 2 });
		if (last.toolName === "tool_search" && ending)
			return toolCall(faux, "mesh_end", { peer: ending });
		return faux.fauxAssistantMessage("sent");
	}
	const words = wordsOf(last);
	const delivered =
		/Mesh message \[([0-9a-f]+)\] \(question\)[^\n]*:\n\nping/.exec(words);
	if (delivered?.[1])
		return toolCall(faux, "mesh_send", {
			re: delivered[1],
			intent: "fyi",
			text: "pong",
		});
	if (/Mesh message \[[0-9a-f]+\][^\n]*:\n\npong/.test(words))
		return faux.fauxAssistantMessage("pong heard");
	const ping = /^ping (\S+)$/m.exec(words);
	if (ping?.[1])
		return toolCall(faux, "mesh_send", {
			to: ping[1],
			intent: "question",
			text: "ping",
		});
	if (toldTo(words, STORE))
		return toolCall(faux, "tool_search", { query: "spend" });
	if (toldTo(words, ACCOUNT))
		return toolCall(faux, "bash", { command: ACCOUNTING });
	const quest = /^(load|spawn) (QEST-[0-9]{8}-[0-9A-Z]{6})$/m.exec(words);
	if (quest?.[1] === "load")
		return toolCall(faux, "quest", { action: "load", id: quest[2] });
	if (quest?.[1] === "spawn")
		return toolCall(faux, "quest", {
			action: "spawn",
			id: quest[2],
			host: "attended",
		});
	if (ENDING.test(words))
		return toolCall(faux, "tool_search", { query: "mesh_end" });
	const handle = /^query (result-[0-9a-f]{16})$/m.exec(words);
	if (handle?.[1])
		return toolCall(faux, "result_query", {
			handle: handle[1],
			expression: "$[*]",
		});
	return faux.fauxAssistantMessage("ok");
}

/** A turn that calls the tool `name` with `args`. */
function toolCall(faux: Faux, name: string, args: object): unknown {
	return faux.fauxAssistantMessage([faux.fauxToolCall(name, args)], {
		stopReason: "toolUse",
	});
}
