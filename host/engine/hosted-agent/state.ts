/**
 * The agent's state as pi's Agent exposes it: the system prompt read from
 * the transcript, and tools and messages copied as they are assigned, a
 * change of tools telling the agent to install them again.
 */
import type { PiLibrary } from "../pi-library.ts";
import type {
	AgentMessage,
	AgentOptions,
	AgentTool,
	Model,
} from "../pi-types.ts";

const DEFAULT_MODEL: Model = {
	id: "unknown",
	provider: "unknown",
	api: "unknown",
};

/** The agent's state, as pi's Agent exposes it; tools and messages copy what is assigned. */
export interface HostedAgentState {
	readonly systemPrompt: string;
	model: Model;
	thinkingLevel: string;
	tools: AgentTool[];
	messages: AgentMessage[];
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
}

export function createState(
	initial: AgentOptions["initialState"],
	library: PiLibrary,
	toolsChanged: () => void,
): HostedAgentState {
	let tools = initial?.tools?.slice() ?? [];
	let messages = initial?.messages?.slice() ?? [];
	const first = library.createInitialSystemMessage(
		initial?.systemPrompt,
		tools.map(library.toToolDeclaration),
	);
	if (messages[0]?.role !== "system" && first) messages.unshift(first);
	let ready = false;
	const state: HostedAgentState = {
		get systemPrompt() {
			return library.getCurrentSystemPrompt(messages);
		},
		model: initial?.model ?? DEFAULT_MODEL,
		thinkingLevel: initial?.thinkingLevel ?? "off",
		get tools() {
			return tools;
		},
		set tools(next: AgentTool[]) {
			tools = next.slice();
			if (ready) toolsChanged();
		},
		get messages() {
			return messages;
		},
		set messages(next: AgentMessage[]) {
			messages = next.slice();
		},
		isStreaming: false,
		pendingToolCalls: new Set(),
	};
	ready = true;
	return state;
}
