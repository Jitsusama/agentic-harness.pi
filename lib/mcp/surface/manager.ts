import * as os from "node:os";
import * as path from "node:path";
import type {
	AgentToolResult,
	ExtensionContext,
	Theme,
	ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { type TSchema, Type } from "typebox";
import {
	DEFAULT_RESULT_CEILING_BYTES,
	enforceResultCeiling,
} from "../ceiling.js";
import type { McpConnection } from "../connection.js";
import { joinTextContent } from "../content.js";
import { toAgentContent } from "../frontend/defaults.js";
import type { FrontEndRegistry } from "../frontend/registry.js";
import type { FrontEndRenderContext, Invoke } from "../frontend/types.js";
import { renderDefaultCall } from "../render/call.js";
import { renderDefaultResult } from "../render/result.js";
import type { DiscoveryEntry } from "../render/tools-list.js";
import type { McpServerConfig, McpTool, McpToolResult } from "../types.js";
import { createProgressiveHelpers, type HelperDescriptor } from "./helpers.js";
import {
	defaultBackendOf,
	resolveToolMode,
	type ServerPolicy,
	type SurfaceConfig,
} from "./policy.js";

/** The tool-render state the host forwards; the manager adds the tool and server count before calling a front-end hook. */
type PiRenderContext = Omit<FrontEndRenderContext, "tool" | "serverCount">;

/** A tool ready to register with pi: identity, schema, execute and render hooks. */
export interface ToolRegistrationDescriptor {
	name: string;
	label: string;
	description: string;
	parameters: TSchema;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>>;
	renderCall(
		args: Record<string, unknown>,
		theme: Theme,
		context: PiRenderContext,
	): Component;
	renderResult(
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: PiRenderContext,
	): Component;
}

/** What changed since the last reconcile: tools to add, emitted names to drop, and the progressive helpers. */
export interface SurfaceDelta {
	added: ToolRegistrationDescriptor[];
	removed: string[];
	progressiveHelpers: ToolRegistrationDescriptor[];
}

/** Turns a connection's live tools into registration deltas. */
export interface SurfaceManager {
	reconcile(): Promise<SurfaceDelta>;
	descriptors(): ToolRegistrationDescriptor[];
	catalog(): DiscoveryEntry[];
}

const MAX_EMITTED_NAME = 47;

/**
 * Create a manager that lists a connection's tools, resolves each to a mode and
 * a front-end, and returns the delta to apply to pi's tool set. Reconciles are
 * single-flight (an overlapping trigger coalesces into one trailing run), and
 * emitted names are assigned once per upstream name so a tool never changes
 * name across reconciles.
 */
export function createSurfaceManager(deps: {
	server: McpServerConfig;
	connection: McpConnection;
	config: () => SurfaceConfig;
	registry: FrontEndRegistry;
	policy?: ServerPolicy;
	serverCount?: () => number;
	/** The absolute cap on any result's model-facing content, and where oversized payloads spill. */
	resultCeiling?: { limitBytes?: number; storageDir?: () => string };
}): SurfaceManager {
	const { server, connection, config, registry, policy } = deps;
	const serverCount = deps.serverCount ?? (() => 1);
	const ceilingBytes =
		deps.resultCeiling?.limitBytes ?? DEFAULT_RESULT_CEILING_BYTES;
	const ceilingStorageDir =
		deps.resultCeiling?.storageDir ??
		(() => path.join(os.tmpdir(), "pi-mcp-results"));
	const backendOf = server.backendOf ?? policy?.backendOf ?? defaultBackendOf;
	const namespace = server.helperNamespace ?? server.id;
	const prefix = server.toolNamePrefix ?? "";

	const emittedNames = new Map<string, string>();
	const takenNames = new Set<string>();
	const toolsByName = new Map<string, McpTool>();
	let prevDirect = new Set<string>();
	let currentDescriptors: ToolRegistrationDescriptor[] = [];
	let currentCatalog: DiscoveryEntry[] = [];

	let inflight: Promise<SurfaceDelta> | null = null;
	let pending = false;

	function emittedName(upstream: string): string {
		const existing = emittedNames.get(upstream);
		if (existing) return existing;
		let candidate = prefix
			? `${prefix}${upstream}`.slice(0, MAX_EMITTED_NAME)
			: upstream;
		for (let n = 2; takenNames.has(candidate); n++) {
			candidate = `${(prefix ? `${prefix}${upstream}` : upstream).slice(0, MAX_EMITTED_NAME - 2)}-${n}`;
		}
		emittedNames.set(upstream, candidate);
		takenNames.add(candidate);
		return candidate;
	}

	async function dispatch(
		tool: McpTool,
		args: Record<string, unknown>,
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<McpToolResult> {
		const resolved = registry.resolve(tool);
		const invoke: Invoke = (callArgs, callSignal) =>
			connection.callTool(tool.name, callArgs, { signal: callSignal });
		const result = await resolved.wrap(invoke, tool)(args, ctx, signal);
		const shaped = resolved.shape(result, tool);
		const capped = enforceResultCeiling(shaped, result, {
			limitBytes: ceilingBytes,
			storageDir: ceilingStorageDir(),
		});
		return { ...result, content: capped };
	}

	function buildDescriptor(tool: McpTool): ToolRegistrationDescriptor {
		const resolved = registry.resolve(tool);
		const enrich = (context: PiRenderContext): FrontEndRenderContext => ({
			...context,
			tool,
			serverCount: serverCount(),
		});
		return {
			name: emittedName(tool.name),
			label: tool.name,
			description: tool.description,
			parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
			execute: async (_id, params, signal, _onUpdate, ctx) => {
				const shaped = await dispatch(tool, params, ctx, signal);
				if (shaped.isError)
					throw new Error(joinTextContent(shaped) || "Tool call failed.");
				return {
					content: toAgentContent(shaped),
					details: shaped.structuredContent,
				};
			},
			renderCall: (args, theme, context) =>
				resolved.renderCall(args, theme, enrich(context)),
			renderResult: (result, options, theme, context) =>
				resolved.renderResult(result, options, theme, enrich(context)),
		};
	}

	function adaptHelper(
		helper: HelperDescriptor,
		parameters: TSchema,
		renderResult?: ToolRegistrationDescriptor["renderResult"],
	): ToolRegistrationDescriptor {
		const syntheticTool: McpTool = {
			serverId: server.id,
			name: helper.name,
			description: helper.description,
			inputSchema: { type: "object" },
			raw: {},
		};
		return {
			name: helper.name,
			label: helper.name,
			description: helper.description,
			parameters,
			execute: async (_id, params, _signal, _onUpdate, ctx) => {
				const result = await helper.run(params, ctx);
				if (result.isError)
					throw new Error(joinTextContent(result) || "Helper failed.");
				return {
					content: toAgentContent(result),
					details: result.structuredContent,
				};
			},
			renderCall: (args, theme) =>
				renderDefaultCall(syntheticTool, args, theme, { multiServer: false }),
			renderResult:
				renderResult ??
				((result, options, theme, context) =>
					renderDefaultResult(result, options, theme, context)),
		};
	}

	// The run-tool helper proxies an arbitrary tool, so its result is rendered
	// through that tool's resolved front-end (the same renderer a direct tool
	// would use), not the generic default. Shaping already rides the dispatch
	// path, so a provider now styles its tools whether they are direct or behind
	// the helper.
	function runToolRenderResult(
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: PiRenderContext,
	): Component {
		const name = (context.args as Record<string, unknown> | undefined)?.name;
		const tool = typeof name === "string" ? toolsByName.get(name) : undefined;
		if (!tool) return renderDefaultResult(result, options, theme, context);
		return registry.resolve(tool).renderResult(result, options, theme, {
			...context,
			tool,
			serverCount: serverCount(),
		});
	}

	function buildHelpers(cfg: SurfaceConfig): ToolRegistrationDescriptor[] {
		const helpers = createProgressiveHelpers({
			namespace,
			catalog: () => currentCatalog,
			hints: cfg.progressiveHints,
			describe: (name) => {
				const tool = toolsByName.get(name);
				return tool ? `${tool.name}: ${tool.description}` : undefined;
			},
			runTool: (name, args, ctx) => {
				const tool = toolsByName.get(name);
				if (!tool)
					return Promise.resolve({
						content: [{ type: "text", text: `Unknown tool ${name}.` }],
						isError: true,
					});
				return dispatch(tool, args, ctx);
			},
		});
		const params = [
			Type.Object({
				query: Type.Optional(Type.String()),
				backend: Type.Optional(Type.String()),
			}),
			Type.Object({ name: Type.String() }),
			Type.Object({
				name: Type.String(),
				arguments: Type.Optional(Type.Unknown()),
			}),
		];
		return helpers.map((helper, index) =>
			adaptHelper(
				helper,
				params[index],
				index === 2 ? runToolRenderResult : undefined,
			),
		);
	}

	async function runReconcile(): Promise<SurfaceDelta> {
		const tools = await connection.listTools();
		const cfg = config();
		toolsByName.clear();
		for (const tool of tools) toolsByName.set(tool.name, tool);

		const entries: DiscoveryEntry[] = [];
		const directDescriptors: ToolRegistrationDescriptor[] = [];
		for (const tool of tools) {
			const mode = resolveToolMode(tool, cfg, tools, backendOf);
			if (mode === "disabled") continue;
			entries.push({
				name: tool.name,
				backend: backendOf(tool.name),
				mode,
				summary: tool.description,
			});
			if (mode === "direct") directDescriptors.push(buildDescriptor(tool));
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		currentCatalog = entries;
		currentDescriptors = directDescriptors;

		const newNames = new Set(
			directDescriptors.map((descriptor) => descriptor.name),
		);
		const added = directDescriptors.filter(
			(descriptor) => !prevDirect.has(descriptor.name),
		);
		const removed = [...prevDirect].filter((name) => !newNames.has(name));
		prevDirect = newNames;

		return { added, removed, progressiveHelpers: buildHelpers(cfg) };
	}

	return {
		reconcile() {
			if (inflight) {
				pending = true;
				return inflight;
			}
			inflight = (async () => {
				try {
					let delta = await runReconcile();
					while (pending) {
						pending = false;
						delta = await runReconcile();
					}
					return delta;
				} finally {
					inflight = null;
				}
			})();
			return inflight;
		},
		descriptors: () => currentDescriptors,
		catalog: () => currentCatalog,
	};
}
