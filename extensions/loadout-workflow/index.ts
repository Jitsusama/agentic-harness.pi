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
 *   reading the skill is the moment it is about to use them;
 * - puts down, at a compaction, the ones loaded and then left alone
 *   since the one before (idle.ts), so a session does not read them on
 *   every turn for the rest of its life.
 *
 * Before a session's first run after a reload or a restart, it waits
 * for the MCP servers the session had to connect again (servers.ts), so
 * that run's prompt and tools read as they did before.
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
import { idleTools } from "./idle.ts";
import { loadable, loadableIndex, namedIn } from "./loadable.ts";
import {
	serversRegistered,
	serversTheSessionHad,
	untilServersReturn,
} from "./servers.ts";
import {
	type LoadoutSettings,
	parseLoadoutSettings,
	placedHere,
	withPackagePlaces,
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
 * Where each skill and tool applies, from the package config's
 * `loadout` section, the skills' over the package's own places; only
 * the package's when the config is missing or its section does not
 * parse.
 */
async function loadoutPlaces(): Promise<LoadoutSettings> {
	const loaded = await loadPackageConfig();
	if (!loaded.ok) return { skills: withPackagePlaces({}), tools: {} };
	const said = getSection(
		loaded.config,
		LOADOUT_SLUG,
		parseLoadoutSettings,
	).value;
	return { skills: withPackagePlaces(said.skills), tools: said.tools };
}

/** The package config section this extension reads. */
const LOADOUT_SLUG = "loadout";

export default function loadoutWorkflow(pi: ExtensionAPI) {
	const waiting = () =>
		loadable(pi.getAllTools(), new Set(pi.getActiveTools()));
	// Every deferred tool, loaded or not, so the section stays the same
	// after a tool is loaded.
	let index: string | undefined;
	// Where each skill and tool applies, read once at start from the
	// package config.
	let places: LoadoutSettings = { skills: {}, tools: {} };
	// Whether this runtime's first run has waited for the session's servers.
	let waited = false;
	const idle = idleTools();

	pi.on("before_agent_start", async (event, ctx) => {
		if (!waited) {
			waited = true;
			await serversBack(ctx?.sessionManager?.getBranch?.() ?? []);
		}
		// pi offers every tool's snippet and rules here, declared or not.
		// A tool placed elsewhere is left out of the index, though
		// tool_search still finds it.
		index ??= loadableIndex(
			placedHere(
				loadable(pi.getAllTools(), new Set()),
				places.tools,
				event.systemPromptOptions.cwd,
			),
			{
				snippets: event.systemPromptOptions.toolSnippets ?? {},
				guidelines: event.systemPromptOptions.toolGuidelines ?? {},
			},
		);
		if (index) event.systemPromptOptions.sections[INDEX_SECTION] = index;
		const skills = event.systemPromptOptions.skills;
		if (skills) {
			event.systemPromptOptions.skills = placedHere(
				skills,
				places.skills,
				event.systemPromptOptions.cwd,
			);
		}
		return undefined;
	});

	/**
	 * Wait for the MCP servers the branch had before this runtime. This
	 * handler runs before pi's own MCP extension writes its section,
	 * since pi loads its built-in extensions after the packages.
	 */
	async function serversBack(branch: readonly unknown[]): Promise<void> {
		const wanted = serversTheSessionHad(branch);
		if (wanted.length === 0) return;
		await untilServersReturn(wanted, () => serversRegistered(pi.getAllTools()));
	}

	// A compaction rebuilds the prompt's head, so what goes from it here
	// costs no cache of its own; put down mid-run, a tool's declaration
	// would stay in the cached head with a notice beside it.
	pi.on("session_compact", async () => {
		const going = new Set(idle.since(loadable(pi.getAllTools(), new Set())));
		if (going.size > 0) {
			pi.setActiveTools(pi.getActiveTools().filter((name) => !going.has(name)));
		}
	});

	pi.on("session_start", async () => {
		places = await loadoutPlaces();
		const active = pi.getActiveTools();
		idle.saw(active);
		const registered = pi
			.getAllTools()
			.some((tool) => tool.name === TOOL_SEARCH);
		if (registered && !active.includes(TOOL_SEARCH)) {
			pi.setActiveTools([...active, TOOL_SEARCH]);
		}
	});

	// pi's own tool_search declares what it finds without saying so, so
	// what is newly declared after any call counts as loaded.
	pi.on("tool_result", async (event) => {
		idle.used(event.toolName);
		idle.saw(pi.getActiveTools());
		if (event.isError || !isSkillRead(event)) return undefined;
		const text = event.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("\n");
		const names = namedIn(text, waiting());
		if (names.length === 0) return undefined;
		pi.setActiveTools([...pi.getActiveTools(), ...names]);
		idle.saw(pi.getActiveTools());
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
