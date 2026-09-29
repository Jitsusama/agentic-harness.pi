/**
 * Every review tool runs with its call's signal.
 *
 * The providers are built once, at registration, and run their gh,
 * git and gs through an exec they were handed then, so nothing about
 * one call could reach the command it started: a hung gh held the
 * call to its clock whatever Escape said. Core's `spawnExec` reads the
 * call's signal when a command starts, so running each tool's execute
 * inside `withCallSignal` stops every command that call made, through
 * any provider, without a signal passed down a single signature.
 */

import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withCallSignal } from "@jitsusama/agentic-harness.core/exec";
import type { TSchema } from "@sinclair/typebox";

/** `pi`, with every tool registered through it run under its call's signal. */
export function withToolCallSignals(pi: ExtensionAPI): ExtensionAPI {
	function registerTool<TParams extends TSchema, TDetails, TState>(
		tool: ToolDefinition<TParams, TDetails, TState>,
	): void {
		pi.registerTool({
			...tool,
			execute: (id, params, signal, onUpdate, ctx) =>
				withCallSignal(signal, () =>
					tool.execute(id, params, signal, onUpdate, ctx),
				),
		});
	}
	return new Proxy(pi, {
		get(target, property) {
			if (property === "registerTool") return registerTool;
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
