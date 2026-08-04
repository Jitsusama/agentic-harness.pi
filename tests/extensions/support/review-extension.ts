/**
 * Just enough of pi's surface to run the review extension in a test.
 *
 * Extension wiring is mostly left to a live session, because it leans on
 * pi's runtime. Two things do not need one: the registration handshake,
 * and a tool's own execute. Every gate in this extension opens with
 * `if (!ctx.hasUI) return { approved: true }`, so a headless caller walks
 * straight through the confirmation and the rest of the path runs
 * normally. That is what makes a tool answerable here at all.
 */

import { vi } from "vitest";
import reviewIntegration from "../../../extensions/review-integration/index.js";

/** A tool as the extension registered it, execute included. */
export type RegisteredTool = {
	name: string;
	execute: (
		id: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<unknown>;
};

/**
 * What the stub should answer for a git command.
 *
 * Keyed by a fragment of the argv, first match winning. Anything
 * unmatched answers empty and succeeds, which is what a checkout with
 * nothing to say looks like: no remotes, no upstream, no tags.
 */
export type ExecAnswers = Record<
	string,
	{ code?: number; stdout?: string; stderr?: string }
>;

/** Build the stub without activating anything. */
export function stubPi(answers: ExecAnswers = {}) {
	const tools: string[] = [];
	const definitions = new Map<string, RegisteredTool>();
	const handlers = new Map<string, (data: unknown) => void>();
	const lifecycle = new Map<string, (event: unknown, ctx: unknown) => void>();
	const emitted: { event: string; data: unknown }[] = [];
	const commands: string[][] = [];

	const exec = vi.fn(async (file: string, args: string[] = []) => {
		commands.push([file, ...args]);
		const line = [file, ...args].join(" ");
		const found = Object.entries(answers).find(([fragment]) =>
			line.includes(fragment),
		);
		return {
			code: found?.[1].code ?? 0,
			stdout: found?.[1].stdout ?? "",
			stderr: found?.[1].stderr ?? "",
		};
	});

	const pi = {
		registerTool(definition: RegisteredTool) {
			tools.push(definition.name);
			definitions.set(definition.name, definition);
		},
		// pi's typed lifecycle hook, which hands over a context. Distinct
		// from the untyped `events` bus below: the progress reporter needs
		// the context, and only this one carries it.
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			lifecycle.set(event, handler);
		},
		exec,
		events: {
			on(event: string, handler: (data: unknown) => void) {
				handlers.set(event, handler);
			},
			emit(event: string, data: unknown) {
				emitted.push({ event, data });
			},
		},
	};
	return {
		pi,
		tools,
		definitions,
		handlers,
		lifecycle,
		emitted,
		exec,
		commands,
	};
}

/**
 * Run the extension against a stub.
 *
 * Note what activating costs: the extension registers its own providers,
 * `github` and `git` among them, into the same process-wide registry a
 * test writes to. A stub sharing one of those ids is replaced by the real
 * one, silently, and the test then exercises a provider it never wrote.
 * Give a stub an id of its own, `plain-vcs` rather than `git`.
 */
export function activate(answers: ExecAnswers = {}) {
	const stub = stubPi(answers);
	// The stub is structural: the extension only uses the parts modelled
	// here, and a real ExtensionAPI is unavailable outside a session.
	reviewIntegration(stub.pi as never);
	return stub;
}

/** The tool the extension registered under this name. */
export function toolNamed(
	stub: ReturnType<typeof activate>,
	name: string,
): RegisteredTool {
	const found = stub.definitions.get(name);
	if (!found) throw new Error(`the extension registered no ${name}`);
	return found;
}

/** A headless tool context: no UI, so every gate approves itself. */
export const HEADLESS = { hasUI: false };
