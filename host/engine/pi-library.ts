/**
 * pi's own functions the host's agent calls rather than copies: the
 * transcript helpers that declare tools, the argument validation tools
 * get, and the identity every request carries. Picked by name from the
 * host's pi, so a renamed export fails at start, naming it.
 *
 * One host serves every conversation from one event loop, and pi
 * declares and compares a conversation's whole tool set before every
 * request, each a JSON round trip of every tool's schema. So a tool's
 * declaration is made once, while its description and parameters stay
 * the same objects, and a comparison where nothing changed answers
 * without pi's: only a change goes to pi, which says what changed.
 */
import type { HostPiModules } from "./host-pi.ts";
import type { AgentMessage, AgentTool, ToolCall } from "./pi-types.ts";

/** A tool as the transcript declares it. */
export type ToolDeclaration = {
	readonly name: string;
	readonly [field: string]: unknown;
};

/** What changed between the tools a transcript declares and those the agent runs. */
export interface ToolStateChanges {
	readonly toolsAdded: readonly ToolDeclaration[];
	readonly toolsRemoved: readonly string[];
}

/** The pi functions the host's agent uses, typed as it uses them. */
export interface PiLibrary {
	readonly createInitialSystemMessage: (
		systemPrompt: string | undefined,
		tools: readonly ToolDeclaration[],
	) => AgentMessage | undefined;
	readonly getCurrentSystemMessage: (
		messages: readonly AgentMessage[],
	) => AgentMessage | undefined;
	readonly getCurrentSystemPrompt: (
		messages: readonly AgentMessage[],
	) => string;
	readonly getCurrentTools: (
		messages: readonly AgentMessage[],
	) => readonly ToolDeclaration[];
	readonly getToolStateChanges: (
		current: readonly ToolDeclaration[],
		next: readonly ToolDeclaration[],
	) => ToolStateChanges;
	readonly toToolDeclaration: (
		tool: AgentTool | ToolDeclaration,
	) => ToolDeclaration;
	readonly normalizeContext: (context: {
		messages: readonly AgentMessage[];
	}) => {
		readonly messages: readonly AgentMessage[];
	};
	readonly validateToolArguments: (tool: AgentTool, call: ToolCall) => unknown;
	readonly mergeClientIdentity: (...sources: readonly unknown[]) => unknown;
	/** pi-agent-core's identity, which an agent's own identity overrides field by field. */
	readonly defaultAgentIdentity: unknown;
}

const AI_FUNCTIONS = [
	"createInitialSystemMessage",
	"getCurrentSystemMessage",
	"getCurrentSystemPrompt",
	"getCurrentTools",
	"getToolStateChanges",
	"toToolDeclaration",
	"normalizeContext",
	"validateToolArguments",
	"mergeClientIdentity",
] as const;

/** Pick the functions the agent uses from the host's pi, refusing one that lacks any. */
export function piLibrary(modules: HostPiModules): PiLibrary {
	const missing = AI_FUNCTIONS.filter(
		(name) => typeof modules.ai[name] !== "function",
	);
	if (!("DEFAULT_AGENT_IDENTITY" in modules.agentCore))
		missing.push("DEFAULT_AGENT_IDENTITY" as never);
	if (missing.length > 0) {
		throw new Error(
			`The host's pi lacks what its agent calls: ${missing.join(", ")}`,
		);
	}
	// Checked above: each is a function of pi-ai's, typed by its documented signature.
	const ai = modules.ai as unknown as Omit<PiLibrary, "defaultAgentIdentity">;
	const declarations = declaredOnce(ai.toToolDeclaration);
	return {
		createInitialSystemMessage: ai.createInitialSystemMessage,
		getCurrentSystemMessage: ai.getCurrentSystemMessage,
		getCurrentSystemPrompt: ai.getCurrentSystemPrompt,
		getCurrentTools: ai.getCurrentTools,
		getToolStateChanges: (current, next) =>
			declarations.same(current, next)
				? { toolsAdded: [], toolsRemoved: [] }
				: ai.getToolStateChanges(current, next),
		toToolDeclaration: declarations.declare,
		normalizeContext: ai.normalizeContext,
		validateToolArguments: ai.validateToolArguments,
		mergeClientIdentity: ai.mergeClientIdentity,
		defaultAgentIdentity: modules.agentCore.DEFAULT_AGENT_IDENTITY,
	};
}

/** A declaration kept with the fields it was made from. */
interface Declared {
	readonly description: unknown;
	readonly parameters: unknown;
	readonly declaration: ToolDeclaration;
}

/**
 * pi's toToolDeclaration made once a tool, and the text pi compares
 * declarations by made once a declaration. Held weakly, so a
 * conversation's tools go when it does.
 */
function declaredOnce(
	toToolDeclaration: (tool: AgentTool | ToolDeclaration) => ToolDeclaration,
) {
	const declared = new WeakMap<object, Declared>();
	const texts = new WeakMap<object, string>();
	const declare = (tool: AgentTool | ToolDeclaration): ToolDeclaration => {
		const kept = declared.get(tool);
		if (
			kept !== undefined &&
			kept.description === tool.description &&
			kept.parameters === tool.parameters
		)
			return kept.declaration;
		const declaration = toToolDeclaration(tool);
		const { description, parameters } = tool;
		declared.set(tool, { description, parameters, declaration });
		return declaration;
	};
	const textOf = (declaration: ToolDeclaration): string => {
		const kept = texts.get(declaration);
		if (kept !== undefined) return kept;
		const text = JSON.stringify(toToolDeclaration(declaration));
		texts.set(declaration, text);
		return text;
	};
	/** Whether pi's getToolStateChanges would find nothing added or removed. */
	const same = (
		current: readonly ToolDeclaration[],
		next: readonly ToolDeclaration[],
	): boolean => {
		const before = new Map(current.map((tool) => [tool.name, tool]));
		const after = new Map(next.map((tool) => [tool.name, tool]));
		const within = (
			tools: readonly ToolDeclaration[],
			others: ReadonlyMap<string, ToolDeclaration>,
		) =>
			tools.every((tool) => {
				const other = others.get(tool.name);
				return other !== undefined && textOf(other) === textOf(tool);
			});
		return within(next, before) && within(current, after);
	};
	return { declare, same };
}
