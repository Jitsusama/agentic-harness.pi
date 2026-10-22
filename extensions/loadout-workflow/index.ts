/**
 * Loadout workflow: tools a session seldom needs are loaded when it
 * needs them rather than declared on every turn.
 *
 * Every declared tool is read again on every turn. From 8 October the
 * home session's first request declared 76 tools in 141,239
 * characters, and about 20 of them, with their rules, had not been
 * called once in two weeks. A tool registered with `deferred` exposure
 * is not declared: pi's own `tool_search` finds and declares it, and
 * since #641 a tool added mid-session keeps the cache.
 *
 * This extension does three things for those tools:
 * - turns `tool_search` on, so there is a way to load them;
 * - puts a short index of them in a prompt section of its own, so the
 *   model knows they exist without reading their declarations. It is
 *   worked out once per runtime and kept, so the section only changes
 *   when the set of deferred tools does, and it is not part of the
 *   resident block, whose freeze outlives a reload and would hide the
 *   index from a session that reloaded onto this code;
 * - loads the ones a skill names when the model reads that skill, since
 *   reading the skill is the moment it is about to use them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadable, loadableIndex, namedIn } from "./loadable.ts";

/** pi's built-in tool that finds and declares undeclared tools. */
const TOOL_SEARCH = "tool_search";

/** The prompt section the index is rendered into. */
export const INDEX_SECTION = "loadable_tools";

/** Whether a read was of a skill's instructions. */
function isSkillRead(event: {
	toolName: string;
	input: Record<string, unknown>;
}) {
	return (
		event.toolName === "read" &&
		typeof event.input.path === "string" &&
		event.input.path.endsWith("SKILL.md")
	);
}

export default function loadoutWorkflow(pi: ExtensionAPI) {
	const waiting = () =>
		loadable(pi.getAllTools(), new Set(pi.getActiveTools()));
	// Every deferred tool, loaded or not, so the section stays the same
	// after a tool is loaded.
	let index: string | undefined;

	pi.on("before_agent_start", async (event) => {
		index ??= loadableIndex(loadable(pi.getAllTools(), new Set()));
		if (index) event.systemPromptOptions.sections[INDEX_SECTION] = index;
		return undefined;
	});

	pi.on("session_start", async () => {
		const active = pi.getActiveTools();
		const registered = pi
			.getAllTools()
			.some((tool) => tool.name === TOOL_SEARCH);
		if (registered && !active.includes(TOOL_SEARCH)) {
			pi.setActiveTools([...active, TOOL_SEARCH]);
		}
	});

	pi.on("tool_result", async (event) => {
		if (event.isError || !isSkillRead(event)) return undefined;
		const text = event.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("\n");
		const names = namedIn(text, waiting());
		if (names.length === 0) return undefined;
		pi.setActiveTools([...pi.getActiveTools(), ...names]);
		return {
			content: [
				...event.content,
				{
					type: "text",
					text: `\n[Loaded for this session, since this skill uses them: ${names.join(", ")}.]`,
				},
			],
		};
	});
}
