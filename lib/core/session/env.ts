/** Environment and launch hints belong to a conversation in a host. */
import { hosted, type LaunchHints, type SessionEnvironment } from "./host.ts";
import { requireSession, type SessionRef } from "./identity.ts";

const processEnvironment: SessionEnvironment = {
	get: (name) => process.env[name],
	set: (name, value) => {
		process.env[name] = value;
	},
	delete: (name) => {
		delete process.env[name];
	},
	snapshot: () => ({ ...process.env }),
};

/** Reads and writes process.env on pi, or the host's conversation environment. */
export function sessionEnv(ref?: SessionRef): SessionEnvironment {
	const host = hosted();
	return host ? host.env(requireSession(ref)) : processEnvironment;
}

/** Consume startup hints once; plain pi's first words remain a file token. */
export function launchHints(ref?: SessionRef): LaunchHints {
	const host = hosted();
	if (host) return host.hints(requireSession(ref));
	const questId = process.env.QUEST_WORKFLOW_AUTOLOAD_ID;
	const orchestrate = process.env.QUEST_WORKFLOW_ORCHESTRATE === "1";
	const firstWordsToken = process.env.QUEST_WORKFLOW_FIRST_WORDS;
	delete process.env.QUEST_WORKFLOW_AUTOLOAD_ID;
	delete process.env.QUEST_WORKFLOW_ORCHESTRATE;
	delete process.env.QUEST_WORKFLOW_FIRST_WORDS;
	return { questId, orchestrate, firstWordsToken };
}
