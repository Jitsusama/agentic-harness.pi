/**
 * Quest actions renamed to the glossary's word, kept apart from the
 * action list so an old name is never read as one the tool offers.
 */

import { isRecord } from "../../lib/internal/record.ts";
import type { QuestAction } from "./actions.ts";

/**
 * Actions renamed to the glossary's word, by their old name. A call
 * still saying the old name, from a skill or a habit, is taken as the
 * new one rather than refused, while the schema shows only the new.
 */
const RENAMED_ACTIONS: Readonly<Record<string, QuestAction>> = {
	"tree-prune": "tree-release",
	workspace: "sessions",
};

/**
 * A quest call's arguments with a renamed action given its new name;
 * anything else comes back as it was, for the schema to judge.
 */
export function withRenamedAction(args: unknown): unknown {
	if (!isRecord(args) || typeof args.action !== "string") return args;
	const renamed = RENAMED_ACTIONS[args.action];
	return renamed ? { ...args, action: renamed } : args;
}
