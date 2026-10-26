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
 *
 * It also lists a skill only where the person says it applies
 * (skills.ts), so a session outside the World monorepo does not read
 * World's skills on every turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getSection,
	loadPackageConfig,
} from "../../lib/internal/config/loader.ts";
import { loadable, loadableIndex, namedIn } from "./loadable.ts";
import {
	parseLoadoutSettings,
	type SkillPlaces,
	skillsHere,
} from "./skills.ts";

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

/**
 * Where each skill applies, from the package config's `loadout`
 * section; nothing, and so every skill everywhere, when the config is
 * missing or its section does not parse.
 */
async function skillPlaces(): Promise<SkillPlaces> {
	const loaded = await loadPackageConfig();
	if (!loaded.ok) return {};
	return getSection(loaded.config, LOADOUT_SLUG, parseLoadoutSettings).value
		.skills;
}

/** The package config section this extension reads. */
const LOADOUT_SLUG = "loadout";

export default function loadoutWorkflow(pi: ExtensionAPI) {
	const waiting = () =>
		loadable(pi.getAllTools(), new Set(pi.getActiveTools()));
	// Every deferred tool, loaded or not, so the section stays the same
	// after a tool is loaded.
	let index: string | undefined;
	// Where each skill applies, read once at start from the package config.
	let places: SkillPlaces = {};

	pi.on("before_agent_start", async (event) => {
		// pi offers every tool's snippet and rules here, declared or not.
		index ??= loadableIndex(loadable(pi.getAllTools(), new Set()), {
			snippets: event.systemPromptOptions.toolSnippets ?? {},
			guidelines: event.systemPromptOptions.toolGuidelines ?? {},
		});
		if (index) event.systemPromptOptions.sections[INDEX_SECTION] = index;
		const skills = event.systemPromptOptions.skills;
		if (skills) {
			event.systemPromptOptions.skills = skillsHere(
				skills,
				places,
				event.systemPromptOptions.cwd,
			);
		}
		return undefined;
	});

	pi.on("session_start", async () => {
		places = await skillPlaces();
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
