/**
 * What the quest verbs that open terminals are opened with: the
 * person's `terminal` settings, the quest and project the request comes
 * from, and the call's own choice of terminal and nesting.
 *
 * The settings live in the `terminal` section of the package config,
 * so subagent, review and terminal settings are all kept in one file
 * and keyed by the same project names.
 */

import { loadPackageConfig } from "../../lib/internal/config/loader.ts";
import { packageConfigPath } from "../../lib/internal/paths.ts";
import { projectOf } from "../../lib/internal/project.ts";
import {
	type OpenOptions,
	parseTerminalSettings,
	readTerminalChoice,
	TERMINAL_LAYOUTS,
	type TerminalLayout,
} from "../../lib/terminal/index.ts";

/** The config section the terminal settings live under. */
export const TERMINAL_SLUG = "terminal";

/** What a call may say about where its terminal opens. */
export interface TerminalCall {
	readonly terminal?: string;
	readonly nesting?: string;
	readonly layout?: string;
	readonly dryRun?: boolean;
}

/** Options to open with, or why the settings or the call cannot be read. */
export type TerminalOptionsRead =
	| {
			readonly ok: true;
			readonly options: OpenOptions;
			readonly layout?: TerminalLayout;
	  }
	| { readonly ok: false; readonly refusal: string };

/**
 * Read the terminal settings and the call's choices into the options
 * `openTerminal` takes. A section that is wrong anywhere is refused
 * naming the field, rather than half read, and so is a call that names
 * a layout or nesting the library does not have.
 */
export async function terminalOptions(
	call: TerminalCall,
	where: { readonly questId?: string; readonly cwd?: string },
): Promise<TerminalOptionsRead> {
	const path = packageConfigPath();
	const loaded = await loadPackageConfig(path);
	if (!loaded.ok) return { ok: false, refusal: loaded.error };
	const parsed = parseTerminalSettings(loaded.config.sections[TERMINAL_SLUG]);
	if (!parsed.ok) return { ok: false, refusal: `${parsed.error} (in ${path})` };
	if (
		call.layout !== undefined &&
		!(TERMINAL_LAYOUTS as readonly string[]).includes(call.layout)
	) {
		return {
			ok: false,
			refusal: `Unknown layout "${call.layout}". Use ${TERMINAL_LAYOUTS.join(", ")}.`,
		};
	}
	let choice: ReturnType<typeof readTerminalChoice>;
	try {
		choice = readTerminalChoice(
			{
				...(call.terminal?.trim() ? { driver: call.terminal.trim() } : {}),
				...(call.nesting?.trim() ? { nesting: call.nesting.trim() } : {}),
			},
			"the call",
		);
	} catch (error) {
		return { ok: false, refusal: (error as Error).message };
	}
	const project = where.cwd ? await projectOf(where.cwd) : undefined;
	return {
		ok: true,
		options: {
			settings: parsed.value,
			place: {
				...(where.questId ? { quest: where.questId } : {}),
				...(project ? { project } : {}),
			},
			call: {
				...(choice.driver ? { driver: choice.driver } : {}),
				...(choice.nesting ? { nesting: choice.nesting } : {}),
			},
			dryRun: call.dryRun === true,
		},
		...(call.layout ? { layout: call.layout as TerminalLayout } : {}),
	};
}
