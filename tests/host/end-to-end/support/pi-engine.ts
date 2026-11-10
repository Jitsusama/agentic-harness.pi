/**
 * H1's engine as a sealed host runs it: createEngine on the pi built with
 * the host's patches, which PI_HOST_PACKAGE_DIR names, every conversation
 * loading this harness as its package, and pi-ai's scripted provider as
 * the model. The provider is registered in the host's own process, as the
 * engine's own tests do, and named in the seal's models.json.
 *
 * The model reads each turn's transcript rather than playing a fixed
 * list, since one provider answers every conversation the host holds and
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
 * - after a tool's result, it says `sent`.
 *
 * A host process imports this by path, under node's own type stripping,
 * so it holds nothing node can't strip.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createEngine } from "../../../../host/engine/engine.ts";
import type { SessionHost } from "../../../../host/engine/session-host.ts";
import type { ConversationEngine } from "../../../../host/service/backend.ts";

/** The scripted provider and model a conversation is opened on. */
export const SCRIPTED = { provider: "sealed-faux", id: "faux-1" } as const;

/** A second model of the same provider, answering the same way. */
export const SCRIPTED_TOO = { provider: "sealed-faux", id: "faux-2" } as const;

/** What a conversation is told to say what it is billed and credited as. */
export const ACCOUNT = "account";

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

/** What a conversation is told to store rows under a handle. */
export const STORE = "store";

/** Fifty rows from SQLite alone, whatever the ledger holds. */
const FIFTY_ROWS = `SELECT value FROM json_each('${JSON.stringify(
	Array.from({ length: 50 }, (_, at) => at + 1),
)}')`;

/** The harness every conversation loads, this tree. */
const HARNESS = resolve(import.meta.dirname, "../../../..");

/** How many answers the scripted model has in it, more than any check asks. */
const ANSWERS = 200;

/** What the module uses of pi-ai's scripted provider. */
interface Compat {
	registerFauxProvider(options: object): {
		readonly api: string;
		setResponses(responses: readonly unknown[]): void;
	};
	fauxAssistantMessage(content: unknown, options?: object): unknown;
	fauxToolCall(name: string, args: object, options?: { id?: string }): unknown;
}

/** One message of a transcript, as the provider is handed it. */
interface Said {
	readonly role: string;
	readonly content?: unknown;
	readonly toolName?: string;
}

/** A pi module as the engine module uses it: pi's JavaScript carries no types here. */
function piModule<T>(module: unknown): T {
	return module as T;
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

/** The scripted model's answer to a transcript. */
function answer(compat: Compat, messages: readonly Said[]): unknown {
	const last = messages.at(-1);
	if (last?.role === "toolResult") {
		const told = wordsOf(
			[...messages].reverse().find((one) => one.role === "user"),
		);
		if (
			last.toolName === "tool_search" &&
			new RegExp(`^${STORE}$`, "m").test(told)
		)
			return toolCall(compat, "spend", { query: FIFTY_ROWS, limit: 2 });
		return compat.fauxAssistantMessage("sent");
	}
	const words = wordsOf(last);
	const delivered =
		/Mesh message \[([0-9a-f]+)\] \(question\)[^\n]*:\n\nping/.exec(words);
	if (delivered?.[1])
		return toolCall(compat, "mesh_send", {
			re: delivered[1],
			intent: "fyi",
			text: "pong",
		});
	if (/Mesh message \[[0-9a-f]+\][^\n]*:\n\npong/.test(words))
		return compat.fauxAssistantMessage("pong heard");
	const told = /^ping (\S+)$/m.exec(words);
	if (told?.[1])
		return toolCall(compat, "mesh_send", {
			to: told[1],
			intent: "question",
			text: "ping",
		});
	if (new RegExp(`^${STORE}$`, "m").test(words))
		return toolCall(compat, "tool_search", { query: "spend" });
	if (new RegExp(`^${ACCOUNT}$`, "m").test(words))
		return toolCall(compat, "bash", { command: ACCOUNTING });
	const handle = /^query (result-[0-9a-f]{16})$/m.exec(words);
	if (handle?.[1])
		return toolCall(compat, "result_query", {
			handle: handle[1],
			expression: "$[*]",
		});
	return compat.fauxAssistantMessage("ok");
}

/** A turn that calls the tool `name` with `args`. */
function toolCall(compat: Compat, name: string, args: object): unknown {
	return compat.fauxAssistantMessage([compat.fauxToolCall(name, args)], {
		stopReason: "toolUse",
	});
}

/** The seal's agent folder: the scripted model, the harness as a package, nothing retried. */
function writeAgentFolder(api: string): void {
	const agentDir = join(homedir(), ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[SCRIPTED.provider]: {
					baseUrl: "http://faux.invalid",
					api,
					apiKey: "$SHOPIFY_PROXY_KEY",
					models: [SCRIPTED, SCRIPTED_TOO].map((model) => ({
						id: model.id,
						name: "Scripted",
						reasoning: false,
						input: ["text"],
						contextWindow: 128_000,
						maxTokens: 16_384,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					})),
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: SCRIPTED.provider,
			defaultModel: SCRIPTED.id,
			packages: [HARNESS],
			retry: { enabled: false },
			compaction: { enabled: false },
		}),
	);
}

/** Build H1's engine over a host's ownership, on the pi PI_HOST_PACKAGE_DIR names. */
export async function engine(host: SessionHost): Promise<ConversationEngine> {
	const packageDir = process.env.PI_HOST_PACKAGE_DIR;
	if (!packageDir)
		throw new Error("PI_HOST_PACKAGE_DIR names no pi built for the host");
	const compat = piModule<Compat>(
		await import(
			pathToFileURL(
				join(packageDir, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
			).href
		),
	);
	const faux = compat.registerFauxProvider({ tokenSize: { min: 2, max: 2 } });
	faux.setResponses(
		Array.from(
			{ length: ANSWERS },
			() => (context: { messages: readonly Said[] }) =>
				answer(compat, context.messages),
		),
	);
	writeAgentFolder(faux.api);
	return createEngine({
		packageDir,
		stateDir: join(homedir(), ".local", "state", "host-engine"),
		host,
		env: { ...process.env },
		key: {
			inherited: false,
			current: async () => "sealed-key",
			refused: () => {},
		},
	});
}
