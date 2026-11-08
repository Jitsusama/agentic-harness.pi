/**
 * Whether the pi a spawn starts will stop at pi's folder-trust prompt
 * before it reads its first words. On 11-07 at 20:20 three of six spawns
 * sat there, in agent-cut trees nobody had trusted, until their
 * orchestrator answered each prompt by typing into the window. A spawn
 * can't answer it, since trusting a folder is the person's call, but it
 * can say the prompt waits, so the spawner knows at once rather than
 * from the first-turn watch.
 *
 * Judged as pi judges it (its docs/security.md): a command-line
 * override decides first, then a folder with resources the trust gates,
 * then the closest saved decision, then the default setting. An
 * extension that answers `project_trust` could decide before the saved
 * decisions; work-integration does, for trees the work tool cut, which
 * Joel ruled trusted on 8 November.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import { isAgentCut } from "../../lib/internal/work-records.ts";

/** What deciding a folder's trust reads, so tests can say it. */
export interface TrustFacts {
	/** Whether the folder holds resources trust gates. */
	readonly gated: (cwd: string) => boolean;
	/** The closest saved decision for the folder, or null for none. */
	readonly saved: (cwd: string) => boolean | null;
	/** The `defaultProjectTrust` setting, `ask` when unset. */
	readonly byDefault: () => string;
	/**
	 * Whether the harness itself trusts the folder before pi asks: a tree
	 * the work tool cut (work-integration answers `project_trust` yes).
	 */
	readonly trustedHere: (cwd: string) => boolean;
}

/** The flags that decide trust for one pi process. */
const TRUST_FLAGS = new Set(["--approve", "-a", "--no-approve", "-na"]);

/** The default setting from pi's settings file, `ask` when it says none. */
function defaultTrustSetting(agentDir: string = getAgentDir()): string {
	try {
		const value: unknown = JSON.parse(
			readFileSync(join(agentDir, "settings.json"), "utf8"),
		);
		if (
			typeof value === "object" &&
			value !== null &&
			"defaultProjectTrust" in value &&
			typeof value.defaultProjectTrust === "string"
		) {
			return value.defaultProjectTrust;
		}
	} catch {
		// No settings file, or one half written, is pi's own default.
	}
	return "ask";
}

/** What this machine's pi reads. */
export const piTrust: TrustFacts = {
	gated: hasTrustRequiringProjectResources,
	saved: (cwd) => new ProjectTrustStore(getAgentDir()).get(cwd),
	byDefault: () => defaultTrustSetting(),
	trustedHere: (cwd) => isAgentCut(cwd),
};

/**
 * Whether a pi started by `command` in `cwd` will ask whether to trust
 * the folder before anything else. A judgement that can't be made says
 * no, since a wrong warning costs the spawner a look and nothing more.
 */
export function trustPromptWaits(
	cwd: string,
	command: string,
	facts: TrustFacts = piTrust,
): boolean {
	if (command.split(/\s+/).some((word) => TRUST_FLAGS.has(word))) {
		return false;
	}
	try {
		if (facts.trustedHere(cwd)) return false;
		if (!facts.gated(cwd)) return false;
		if (facts.saved(cwd) !== null) return false;
		return facts.byDefault() === "ask";
	} catch {
		// A folder that can't be read can't be judged; say nothing.
		return false;
	}
}

/** What a spawn's answer says when the trust prompt waits in `cwd`. */
export function trustPromptNote(cwd: string): string {
	return ` Nothing has trusted ${cwd}, so its pi stops at pi's folder-trust prompt before it reads its note: answer it in the new window, or spawn with a cwd that is trusted.`;
}
