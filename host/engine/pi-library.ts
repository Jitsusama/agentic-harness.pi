/**
 * pi's own functions the host's agent calls rather than copies: the
 * transcript helpers that declare tools, the argument validation tools
 * get, and the identity every request carries. Picked by name from the
 * host's pi, so a renamed export fails at start, naming it.
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
	readonly toToolDeclaration: (tool: AgentTool) => ToolDeclaration;
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
	return {
		createInitialSystemMessage: ai.createInitialSystemMessage,
		getCurrentSystemMessage: ai.getCurrentSystemMessage,
		getCurrentSystemPrompt: ai.getCurrentSystemPrompt,
		getCurrentTools: ai.getCurrentTools,
		getToolStateChanges: ai.getToolStateChanges,
		toToolDeclaration: ai.toToolDeclaration,
		normalizeContext: ai.normalizeContext,
		validateToolArguments: ai.validateToolArguments,
		mergeClientIdentity: ai.mergeClientIdentity,
		defaultAgentIdentity: modules.agentCore.DEFAULT_AGENT_IDENTITY,
	};
}
