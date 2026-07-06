/**
 * Point-of-use hydration of the council roster and judge.
 *
 * Running a review used to require the user to configure the
 * roster and judge by hand every session (council-config
 * then judge-config) before council, stack review or judge
 * would run. When a config file supplies defaults, this
 * fills an unset roster and judge from it the moment a
 * review needs them, so the review just runs. It leaves an
 * already-configured session untouched, and only errors
 * when the config file itself cannot supply the missing
 * piece, pointing the user at the manual command as a
 * fallback.
 */

import type { PrWorkflowConfigLoadResult } from "./config.js";
import { loadPrWorkflowConfig } from "./config.js";
import { configureCouncil } from "./council-action.js";
import { configureJudge } from "./judge-action.js";
import type { PrWorkflowState } from "./state.js";

/** Outcome of {@link ensureCouncilConfigured}. */
export type EnsureCouncilConfiguredResult =
	| { ok: true; hydrated: { roster?: number; judge?: string; path?: string } }
	| { ok: false; error: string };

/**
 * Ensure the session has a council roster and a judge,
 * hydrating either from the config file when it is unset.
 */
export async function ensureCouncilConfigured(
	state: PrWorkflowState,
	loadConfig: () => Promise<PrWorkflowConfigLoadResult> = loadPrWorkflowConfig,
): Promise<EnsureCouncilConfiguredResult> {
	const needRoster = state.council.roster.length === 0;
	const needJudge = state.council.judge === null;
	if (!needRoster && !needJudge) return { ok: true, hydrated: {} };

	const loaded = await loadConfig();
	if (!loaded.ok) {
		return {
			ok: false,
			error:
				`Council is not configured and no config file could supply defaults: ${loaded.error} ` +
				"Call pr_workflow action=council-config and action=judge-config, " +
				"or create a config file with a top-level `reviewers` array and `judge`.",
		};
	}

	const { defaults, path } = loaded.config;
	const hydrated: { roster?: number; judge?: string; path?: string } = {};

	if (needRoster) {
		const reviewers = defaults.reviewers;
		if (reviewers === undefined || reviewers.length === 0) {
			return {
				ok: false,
				error:
					`Council roster is empty and the config at ${path} has no reviewers. ` +
					"Call pr_workflow action=council-config first.",
			};
		}
		const configured = configureCouncil(state, { reviewers: [...reviewers] });
		if (!configured.ok) return configured;
		hydrated.roster = state.council.roster.length;
		hydrated.path = path;
	}

	if (needJudge) {
		const judge = defaults.judge;
		if (judge === undefined) {
			return {
				ok: false,
				error:
					`Judge is not configured and the config at ${path} has no judge. ` +
					"Call pr_workflow action=judge-config first.",
			};
		}
		const configured = configureJudge(state, { judge });
		if (!configured.ok) return configured;
		hydrated.judge = judge.id;
		hydrated.path = path;
	}

	return { ok: true, hydrated };
}
