/**
 * Memory Integration extension.
 *
 * Durable, quest-scoped facts so the agent stops re-onboarding
 * every session. Four tools let the agent retain, recall,
 * reflect over and curate facts; a prompt contributor
 * rehydrates the active scope's facts into the resident system
 * prompt (frozen per session by the coordinator, so a
 * mid-session retain reaches the agent through recall rather
 * than by changing the frozen block). When a quest concludes
 * or retires, its scoped facts are archived.
 *
 * The domain logic lives in lib/memory; this extension is the
 * thin wiring plus the store handle cached for the session.
 * No slash command: the agent calls the tools.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { packageStateDir } from "../../lib/internal/package-state-dir.js";
import {
	type Fact,
	type MemoryStore,
	openMemoryStore,
	resolveScope,
} from "../../lib/memory/index.js";
import { registerPromptContributor } from "../../lib/prompt/index.js";

/** Memory recall sits just below the conventions in the resident block. */
const MEMORY_ORDER = 10;
/** How many facts to rehydrate into the prompt on resume. */
const REHYDRATE_LIMIT = 12;

interface MemoryDetails {
	readonly ok: boolean;
	readonly count?: number;
}

export default function memoryIntegration(pi: ExtensionAPI) {
	let store: MemoryStore | null = null;

	pi.on("session_start", async () => {
		if (store) return;
		const dir = packageStateDir("memory");
		mkdirSync(dir, { recursive: true });
		store = await openMemoryStore(join(dir, "memory.db"));
	});

	pi.on("session_shutdown", async () => {
		const closing = store;
		store = null;
		await closing?.close();
	});

	// Rehydrate the active scope's facts into the resident prompt.
	registerPromptContributor({
		id: "memory",
		order: MEMORY_ORDER,
		async contribute(ctx) {
			if (!store) return undefined;
			const facts = await store.recall({
				scope: resolveScope(ctx),
				limit: REHYDRATE_LIMIT,
			});
			if (facts.length === 0) return undefined;
			const lines = facts.map((f) => `- ${f.text}`).join("\n");
			return `## Remembered\n\nFacts retained from earlier work on this quest or project:\n${lines}`;
		},
	});

	// Archive a quest's facts when it concludes or retires.
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError || event.toolName !== "quest") return;
		const action = event.input.action;
		if (action !== "conclude" && action !== "retire") return;
		if (!store) return;
		for (const id of concludedQuestIds(event.input, ctx)) {
			await store.concludeScope({ kind: "quest", id }, "archive");
		}
	});

	pi.registerTool({
		name: "memory_retain",
		label: "Retain Memory",
		description:
			"Remember a durable fact scoped to the loaded quest (or the " +
			"project). Use for decisions, where things live, and rationale " +
			"worth keeping across sessions; not for transient detail.",
		promptSnippet:
			"Retain durable facts (decisions, locations, rationale) with " +
			"memory_retain so they survive across sessions.",
		parameters: Type.Object({
			text: Type.String({
				description: "The fact to remember, in one sentence.",
			}),
			tags: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional keywords for recall.",
				}),
			),
			source: Type.Optional(
				Type.String({
					description: "Where the fact came from, for later checking.",
				}),
			),
		}),
		async execute(
			_id,
			params,
			_signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<MemoryDetails>> {
			if (!store) return notReady();
			const fact = await store.retain({
				scope: resolveScope(ctx),
				text: params.text,
				...(params.tags ? { tags: params.tags } : {}),
				...(params.source ? { source: params.source } : {}),
			});
			return {
				content: [{ type: "text", text: `Retained #${fact.id}: ${fact.text}` }],
				details: { ok: true, count: 1 },
			};
		},
	});

	pi.registerTool({
		name: "memory_recall",
		label: "Recall Memory",
		description:
			"Recall durable facts for the loaded quest or project, optionally " +
			"filtered by a keyword. Use before re-deriving context you may have " +
			"already recorded.",
		promptSnippet:
			"Before re-deriving project context, recall it with memory_recall.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description:
						"Keyword or tag to filter by. Omit for all facts in scope.",
				}),
			),
			limit: Type.Optional(
				Type.Number({ description: "Maximum facts to return." }),
			),
		}),
		async execute(
			_id,
			params,
			_signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<MemoryDetails>> {
			if (!store) return notReady();
			const facts = await store.recall({
				scope: resolveScope(ctx),
				...(params.query ? { text: params.query } : {}),
				...(params.limit ? { limit: params.limit } : {}),
			});
			return {
				content: [{ type: "text", text: formatFacts(facts) }],
				details: { ok: true, count: facts.length },
			};
		},
	});

	pi.registerTool({
		name: "memory_reflect",
		label: "Reflect Memory",
		description:
			"Ask memory to synthesize an answer over the facts it holds for the " +
			"current scope, rather than listing raw facts.",
		parameters: Type.Object({
			question: Type.String({
				description: "The question to answer from remembered facts.",
			}),
		}),
		async execute(
			_id,
			params,
			_signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<MemoryDetails>> {
			if (!store) return notReady();
			const text = await store.reflect({
				scope: resolveScope(ctx),
				question: params.question,
			});
			return { content: [{ type: "text", text }], details: { ok: true } };
		},
	});

	pi.registerTool({
		name: "memory_edit",
		label: "Edit Memory",
		description:
			"Amend a fact's text or tags, or invalidate it when it is wrong or " +
			"superseded. An invalidated fact is never recalled again.",
		parameters: Type.Object({
			id: Type.Number({ description: "The fact id from memory_recall." }),
			text: Type.Optional(Type.String({ description: "Replacement text." })),
			tags: Type.Optional(
				Type.Array(Type.String(), { description: "Replacement tags." }),
			),
			invalidate: Type.Optional(
				Type.Boolean({
					description: "Forget the fact instead of amending it.",
				}),
			),
		}),
		async execute(_id, params): Promise<AgentToolResult<MemoryDetails>> {
			if (!store) return notReady();
			if (params.invalidate) {
				await store.invalidate(params.id);
				return {
					content: [{ type: "text", text: `Invalidated #${params.id}.` }],
					details: { ok: true },
				};
			}
			const fact = await store.edit(params.id, {
				...(params.text !== undefined ? { text: params.text } : {}),
				...(params.tags !== undefined ? { tags: params.tags } : {}),
			});
			return {
				content: [
					{
						type: "text",
						text: fact
							? `Updated #${fact.id}: ${fact.text}`
							: `No fact #${params.id}.`,
					},
				],
				details: { ok: fact !== null },
			};
		},
	});
}

function notReady(): AgentToolResult<MemoryDetails> {
	return {
		content: [{ type: "text", text: "Memory store is not open." }],
		details: { ok: false },
	};
}

function formatFacts(facts: readonly Fact[]): string {
	if (facts.length === 0) return "No matching facts.";
	return facts.map((f) => `#${f.id} ${f.text}`).join("\n");
}

/** The quest ids a conclude/retire call targets. */
function concludedQuestIds(
	input: Record<string, unknown>,
	ctx: ExtensionContext,
): string[] {
	const id = input.id;
	if (typeof id === "string" && id.trim()) {
		return id
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.startsWith("QEST-"));
	}
	const scope = resolveScope(ctx);
	return scope.kind === "quest" ? [scope.id] : [];
}
