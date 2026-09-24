/**
 * The record, read from disk after each tool call and once more before
 * the agent settles.
 *
 * The gate refuses only what a path decides, and a command can make
 * files without naming them, so the check that cannot be fooled is the
 * disk itself. After a call that could touch a quest folder, the watch
 * audits the quests it could touch and tells the agent what that call
 * broke, in the result it is about to read. Before the run settles, it
 * asks the agent to continue once with whatever it broke and left.
 *
 * Only breakage a call introduced is ever reported. A quest broken
 * before the session started stays quiet until its migration, rather
 * than repeating itself after every command.
 */

import { join } from "node:path";
import { questRecordPath } from "@jitsusama/agentic-harness.core/quest/record";
import {
	auditQuestRecord,
	type RecordAudit,
} from "@jitsusama/agentic-harness.core/quest/record-audit";
import { recordWritesOf } from "./enforce.ts";
import type { QuestState } from "./state.ts";
import { workspaceDirOf } from "./workspace.ts";

/** One thing wrong with a record: a stable key and what to tell the agent. */
interface Breakage {
	readonly key: string;
	readonly line: string;
}

/** Where the record and the workspaces live. */
export interface WatchRoots {
	readonly questsRoot: string;
	readonly workspaceRoot: string;
}

/** Watches quest records for breakage the agent's own calls introduce. */
export class RecordWatch {
	/** Each quest's breakage as of its last audit. */
	private readonly known = new Map<string, Map<string, Breakage>>();
	/** The quests each call in flight could touch. */
	private readonly calls = new Map<string, readonly string[]>();
	/** Breakage reported during this run, by quest. */
	private readonly reported = new Map<string, Set<string>>();
	/** What the last continuation asked about, so it is never asked twice. */
	private lastAsked: string | undefined;

	constructor(private readonly roots: WatchRoots) {}

	/** Note the quests a call could touch, reading any not yet seen. */
	before(toolCallId: string, quests: readonly string[]): void {
		if (quests.length === 0) return;
		this.calls.set(toolCallId, quests);
		for (const quest of quests) {
			if (!this.known.has(quest)) this.known.set(quest, this.breakage(quest));
		}
	}

	/** What the call broke, as text to append to its result. */
	after(toolCallId: string): string | undefined {
		const quests = this.calls.get(toolCallId);
		this.calls.delete(toolCallId);
		if (!quests) return;
		const fresh = new Map<string, Breakage[]>();
		for (const quest of quests) {
			const before = this.known.get(quest) ?? new Map();
			const now = this.breakage(quest);
			this.known.set(quest, now);
			const introduced = [...now.values()].filter((b) => !before.has(b.key));
			if (introduced.length === 0) continue;
			fresh.set(quest, introduced);
			const reported = this.reported.get(quest) ?? new Set();
			for (const b of introduced) reported.add(b.key);
			this.reported.set(quest, reported);
		}
		if (fresh.size === 0) return;
		return `Quest workflow: that call left a quest record out of shape. Put it right now:\n${describe(fresh)}`;
	}

	/**
	 * What to continue with before the run settles, or undefined when
	 * the run left nothing broken or already asked about exactly this.
	 */
	settle(): string | undefined {
		const left = new Map<string, Breakage[]>();
		for (const [quest, keys] of this.reported) {
			const now = this.breakage(quest);
			this.known.set(quest, now);
			const still = [...now.values()].filter((b) => keys.has(b.key));
			if (still.length > 0) left.set(quest, still);
		}
		const asked = [...left]
			.flatMap(([quest, list]) => list.map((b) => `${quest}:${b.key}`))
			.sort()
			.join("\n");
		if (left.size === 0 || asked === this.lastAsked) {
			this.reported.clear();
			return;
		}
		this.lastAsked = asked;
		return `Quest workflow: this run left quest records out of shape. Put them right before finishing:\n${describe(left)}`;
	}

	private breakage(quest: string): Map<string, Breakage> {
		const questDir = join(this.roots.questsRoot, quest);
		let audit: RecordAudit;
		try {
			audit = auditQuestRecord(questDir);
		} catch {
			// A quest that vanished or cannot be read has no record to judge.
			return new Map();
		}
		const workspace = workspaceDirOf(this.roots.workspaceRoot, quest) ?? "";
		const found: Breakage[] = [
			...audit.strays.map((rel) => ({
				key: `stray:${rel}`,
				line: `${rel} is not part of the record. Move it to the workspace: ${join(workspace, rel)}`,
			})),
			...audit.attachments.map(({ rel, problem }) => ({
				key: `attachment:${rel}:${problem.reason}`,
				line: `${rel} is ${problem.detail}. Move it to the workspace: ${join(workspace, rel.replace(/^attachments\//, ""))}`,
			})),
			...audit.broken.map(({ document, target }) => ({
				key: `broken:${document}:${target}`,
				line: `${document} links to ${target}, which is not in attachments/. Restore the file or fix the link.`,
			})),
		];
		return new Map(found.map((b) => [b.key, b]));
	}
}

/** The breakage as a list per quest. */
function describe(byQuest: Map<string, Breakage[]>): string {
	return [...byQuest]
		.map(
			([quest, list]) =>
				`${quest}:\n${list.map((b) => `- ${b.line}`).join("\n")}`,
		)
		.join("\n");
}

/**
 * The quests a tool call could change: those its resolved writes land
 * in, and for bash, whose writes are never wholly known, the loaded
 * quest and the one the shell starts in.
 */
export function questsTouchedBy(
	state: QuestState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	home: string,
): string[] {
	if (toolName !== "bash" && toolName !== "write" && toolName !== "edit") {
		return [];
	}
	const quests = new Set<string>();
	const note = (path: string) => {
		const place = questRecordPath(state.questsRoot, path);
		if (place) quests.add(place.quest);
	};
	for (const write of recordWritesOf(toolName, input, cwd, home)) {
		note(write.path);
	}
	if (toolName === "bash") {
		if (state.questId) quests.add(state.questId);
		note(cwd);
	}
	return [...quests];
}
