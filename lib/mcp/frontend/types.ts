import type {
	AgentToolResult,
	ExtensionContext,
	Theme,
	ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import type { McpContent, McpTool, McpToolResult } from "../types.js";

/** How a provider selects which tools it applies to. */
export type FrontEndMatcher =
	| { kind: "tool"; name: string }
	| { kind: "glob"; pattern: string }
	| { kind: "backend"; backend: string }
	| { kind: "predicate"; test: (tool: McpTool) => boolean };

/** Call the upstream tool and return its raw result. */
export type Invoke = (
	args: Record<string, unknown>,
	signal?: AbortSignal,
) => Promise<McpToolResult>;

/**
 * A tool's execute after the front-end has wrapped it (gate, arg massaging).
 * It returns the transport-shaped result; the core applies the shaper and
 * converts to pi content afterwards, so a gate never touches shaping.
 */
export type WrappedExecute = (
	args: Record<string, unknown>,
	ctx: ExtensionContext,
	signal?: AbortSignal,
) => Promise<McpToolResult>;

/** The outcome of a confirmation gate: approved with data, redirected with a note, or cancelled. */
export type ConfirmResult<T> =
	| { approved: true; data: T }
	| { approved: false; redirect: string }
	| null;

/**
 * What the front-end hooks receive: pi's tool-render state plus the tool being
 * rendered and how many servers are mounted, both added by the host so a
 * renderer can title the call and decide whether to show a server prefix.
 */
export interface FrontEndRenderContext {
	expanded: boolean;
	isPartial: boolean;
	isError: boolean;
	args: Record<string, unknown>;
	toolCallId: string;
	tool: McpTool;
	serverCount: number;
}

/**
 * A single pluggable front-end for a server's tools.
 *
 * One matcher selects the tools it applies to; each hook is optional and, when
 * omitted, the core default is used instead. A host resolves the winning
 * provider per hook, so a broad glob provider that only styles results
 * composes with an exact-tool provider that only styles the call line.
 */
export interface FrontEndProvider {
	/** The server whose tools this provider decorates. */
	serverId: string;
	/** Identifies this provider for replacement and removal. */
	providerId: string;
	/** Which tools this provider applies to. */
	match: FrontEndMatcher;
	/** Higher wins when two providers tie on specificity. Defaults to zero. */
	priority?: number;
	/** Reshape the model-facing content of a result. */
	shape?(result: McpToolResult, tool: McpTool): McpContent[];
	/** Render the user-facing call line. */
	renderCall?(
		args: Record<string, unknown>,
		theme: Theme,
		context: FrontEndRenderContext,
	): Component;
	/** Render the user-facing result. */
	renderResult?(
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: FrontEndRenderContext,
	): Component;
	/** Wrap execution to insert a gate or massage arguments. */
	wrap?(invoke: Invoke, tool: McpTool): WrappedExecute;
}

/** The four hooks resolved for a tool, each either a provider's or the core default. */
export interface ResolvedFrontEnd {
	shape: NonNullable<FrontEndProvider["shape"]>;
	renderCall: NonNullable<FrontEndProvider["renderCall"]>;
	renderResult: NonNullable<FrontEndProvider["renderResult"]>;
	wrap: NonNullable<FrontEndProvider["wrap"]>;
}
