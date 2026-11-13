/**
 * The host's picks of pi's transcript helpers: a tool set seen before is
 * neither declared nor compared again, while any change still goes to
 * pi's own comparison. pi's helpers are stood in for by ones that count
 * their calls and answer as pi's do.
 */
import { describe, expect, it } from "vitest";
import type { HostPiModules } from "../../../host/engine/host-pi.ts";
import {
	type PiLibrary,
	piLibrary,
	type ToolDeclaration,
} from "../../../host/engine/pi-library.ts";
import type { AgentTool } from "../../../host/engine/pi-types.ts";

/** pi-ai's helpers, counting how often the costly ones run. */
function counted() {
	const calls = { declared: 0, compared: 0 };
	const toToolDeclaration = (tool: AgentTool | ToolDeclaration) => {
		calls.declared += 1;
		return {
			name: tool.name,
			description: tool.description,
			parameters: JSON.parse(JSON.stringify(tool.parameters ?? {})),
		};
	};
	const text = (tool: ToolDeclaration) =>
		JSON.stringify(toToolDeclaration(tool));
	const getToolStateChanges = (
		previous: readonly ToolDeclaration[],
		current: readonly ToolDeclaration[],
	) => {
		calls.compared += 1;
		const before = new Map(previous.map((tool) => [tool.name, tool]));
		const after = new Map(current.map((tool) => [tool.name, tool]));
		const differs = (
			tool: ToolDeclaration,
			others: Map<string, ToolDeclaration>,
		) => {
			const other = others.get(tool.name);
			return other === undefined || text(other) !== text(tool);
		};
		return {
			toolsAdded: current.filter((tool) => differs(tool, before)),
			toolsRemoved: previous
				.filter((tool) => differs(tool, after))
				.map((tool) => tool.name),
		};
	};
	const ai = {
		createInitialSystemMessage: () => undefined,
		getCurrentSystemMessage: () => undefined,
		getCurrentSystemPrompt: () => "",
		getCurrentTools: () => [],
		getToolStateChanges,
		toToolDeclaration,
		normalizeContext: (context: unknown) => context,
		validateToolArguments: () => ({}),
		mergeClientIdentity: () => ({}),
	};
	const modules: HostPiModules = {
		codingAgent: {},
		builtins: {},
		projectTrust: {},
		agentCore: { DEFAULT_AGENT_IDENTITY: {} },
		ai,
		tui: {},
		durable: {},
		sqlite: {},
		nodeEnv: {},
		context: {},
	};
	return { calls, library: piLibrary(modules) };
}

function tool(name: string, description = `${name} does a thing`): AgentTool {
	return {
		name,
		description,
		parameters: { type: "object", properties: { path: { type: "string" } } },
		execute: async () => ({ content: [], details: undefined }),
	};
}

/** One request's steps: the transcript's tools against the agent's. */
function request(
	library: PiLibrary,
	declared: readonly ToolDeclaration[],
	tools: readonly AgentTool[],
) {
	return library.getToolStateChanges(
		declared,
		tools.map(library.toToolDeclaration),
	);
}

describe("the host's picks of pi's transcript helpers", () => {
	it("declares and compares a tool set seen before at no cost", () => {
		const { calls, library } = counted();
		const tools = [tool("read"), tool("bash"), tool("edit")];
		const declared = tools.map(library.toToolDeclaration);
		const first = { ...calls };
		for (let turn = 0; turn < 5; turn += 1) {
			expect(request(library, declared, tools)).toEqual({
				toolsAdded: [],
				toolsRemoved: [],
			});
		}
		expect(calls.compared, "pi compared nothing unchanged").toBe(0);
		expect(
			calls.declared - first.declared,
			"each declaration's text made once, never again",
		).toBe(tools.length);
	});

	it("gives a changed tool to pi's comparison", () => {
		const { calls, library } = counted();
		const declared = [tool("read"), tool("bash")].map(
			library.toToolDeclaration,
		);
		const changes = request(library, declared, [
			tool("read", "read reads more now"),
			tool("bash"),
		]);
		expect(calls.compared).toBe(1);
		expect(changes.toolsAdded.map((added) => added.name)).toEqual(["read"]);
		expect(changes.toolsRemoved).toEqual(["read"]);
	});

	it("gives an added or removed tool to pi's comparison", () => {
		const { calls, library } = counted();
		const declared = [tool("read"), tool("bash")].map(
			library.toToolDeclaration,
		);
		expect(
			request(library, declared, [tool("read")]).toolsRemoved,
		).toEqual(["bash"]);
		expect(
			request(library, declared, [tool("read"), tool("bash"), tool("job")])
				.toolsAdded.map((added) => added.name),
		).toEqual(["job"]);
		expect(calls.compared).toBe(2);
	});

	it("declares a tool again once its description or parameters are new", () => {
		const { library } = counted();
		const changing = { ...tool("read") };
		const before = library.toToolDeclaration(changing);
		expect(library.toToolDeclaration(changing)).toBe(before);
		Object.assign(changing, { description: "read reads more now" });
		expect(library.toToolDeclaration(changing).description).toBe(
			"read reads more now",
		);
	});
});
