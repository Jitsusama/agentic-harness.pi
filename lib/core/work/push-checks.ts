/**
 * The fast checks a checkout's owner has run before each of its pushes.
 *
 * A check that failed was found only at the gate on 10 changes in the
 * week to 27 November, each a push, a wait for the gate and a push
 * again. Nothing ran before the push: `work push` went straight to git.
 * So a checkout the package config's `work` section names has its
 * check run in the tree first, and a check that fails stops the push
 * (`publish.ts`). There is no switch to skip it: whoever wants it gone
 * takes the entry out.
 *
 * The section keys checks as it keys fetch rules (`fetch-rules.ts`),
 * by the checkout's common git folder:
 * `{"pushChecks": {"<git folder>": {"run": "...", "seconds": 300}}}`.
 * A section written wrong pushes as it always did.
 */

import { loadPackageConfig } from "../../internal/config/loader.ts";
import { packageConfigPath } from "../../internal/paths.ts";
import { isRecord } from "../../internal/record.ts";
import { byGitFolder, WORK_SLUG } from "./fetch-rule-config.ts";
import { withoutTrailingSlash } from "./fetch-rules.ts";

/** What a checkout runs before each push. */
export interface PushCheck {
	/** Shell text, run by bash in the tree being pushed. */
	readonly run: string;
	/** How long it may run before it is stopped and the push refused. */
	readonly seconds: number;
}

/** How long a check runs when its entry doesn't say. */
export const DEFAULT_CHECK_SECONDS = 300;

/**
 * The longest a check may run. A push waits on it with the person's
 * turn held, so a slow suite belongs at the gate rather than here.
 */
export const MOST_CHECK_SECONDS = 900;

/** The `work` section's push checks, keyed by git folder, and what was wrong. */
export interface ParsedPushChecks {
	readonly checks: Readonly<Record<string, PushCheck>>;
	readonly problems: readonly string[];
}

/**
 * The push checks a `work` section gives; an entry that isn't one is
 * reported and left out, and one asking for longer than the most runs
 * for the most, saying so.
 */
export function parseWorkPushChecks(section: unknown): ParsedPushChecks {
	if (section === undefined) return { checks: {}, problems: [] };
	if (!isRecord(section)) {
		return { checks: {}, problems: ["work: the section is not an object."] };
	}
	const listed = section.pushChecks;
	if (listed === undefined) return { checks: {}, problems: [] };
	if (!isRecord(listed)) {
		return {
			checks: {},
			problems: ["work.pushChecks: not an object of git folders."],
		};
	}
	const checks: Record<string, PushCheck> = {};
	const problems: string[] = [];
	for (const [folder, value] of Object.entries(listed)) {
		const check = checkOf(value);
		if (typeof check === "string") {
			problems.push(`work.pushChecks.${folder}: ${check}`);
		} else if (!folder.startsWith("/")) {
			problems.push(`work.pushChecks.${folder}: not an absolute git folder.`);
		} else {
			if (check.capped) {
				problems.push(
					`work.pushChecks.${folder}: seconds is past ${MOST_CHECK_SECONDS}, so it runs for ${MOST_CHECK_SECONDS}.`,
				);
			}
			checks[withoutTrailingSlash(folder)] = check.check;
		}
	}
	return { checks, problems };
}

function checkOf(
	value: unknown,
): { check: PushCheck; capped: boolean } | string {
	if (!isRecord(value)) return "not an object.";
	const { run, seconds } = value;
	if (typeof run !== "string" || !run.trim()) return "run is not shell text.";
	if (seconds === undefined) {
		return { check: { run, seconds: DEFAULT_CHECK_SECONDS }, capped: false };
	}
	if (
		typeof seconds !== "number" ||
		!Number.isInteger(seconds) ||
		seconds <= 0
	) {
		return "seconds is not a whole number of seconds above 0.";
	}
	return {
		check: { run, seconds: Math.min(seconds, MOST_CHECK_SECONDS) },
		capped: seconds > MOST_CHECK_SECONDS,
	};
}

/**
 * The push check for the checkout whose common git folder is `gitDir`,
 * read afresh from the config at `configPath`; nothing when it names
 * none or can't be read, since a checkout nobody checks pushes as it
 * always did. The folder is matched as a fetch rule's is.
 */
export async function configuredPushCheck(
	gitDir: string,
	configPath: string = packageConfigPath(),
): Promise<PushCheck | undefined> {
	const loaded = await loadPackageConfig(configPath);
	if (!loaded.ok) return undefined;
	const { checks } = parseWorkPushChecks(loaded.config.sections[WORK_SLUG]);
	return byGitFolder(checks, gitDir);
}
