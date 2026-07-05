import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditSessionMembership } from "../../../extensions/quest-workflow/lookup";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import {
	parseQuestFrontMatter,
	serializeQuestFrontMatter,
} from "../../../lib/quest/index";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;

function fakePi() {
	return { setSessionName: () => {} } as unknown as Parameters<
		typeof handle
	>[1];
}
function fakeCtx() {
	return {
		cwd: tmpRoot,
		sessionManager: { getSessionId: () => "sess-1" },
	} as unknown as Parameters<typeof handle>[2];
}
function buildState() {
	return createQuestState({ questsRoot: join(tmpRoot, "quests") });
}

async function createQuest(
	state: ReturnType<typeof buildState>,
	title: string,
): Promise<{ id: string; dir: string }> {
	const result = await handle(state, fakePi(), fakeCtx(), {
		action: "create",
		title,
	});
	if (!result.ok) throw new Error(result.guidance);
	const { id } = result.details as { id: string };
	return { id, dir: join(tmpRoot, "quests", id) };
}

function addActiveSession(dir: string, sessionId: string): void {
	const path = join(dir, "README.md");
	const parsed = parseQuestFrontMatter(readFileSync(path, "utf8"));
	if (!parsed) throw new Error("unreadable");
	parsed.frontMatter.sessions = [
		...parsed.frontMatter.sessions.filter((s) => s.id !== sessionId),
		{ id: sessionId, started: new Date().toISOString(), status: "active" },
	];
	writeFileSync(
		path,
		`${serializeQuestFrontMatter(parsed.frontMatter)}\n${parsed.body}`,
	);
}

const envGuard = createEnvGuard();
let savedHome: string | undefined;
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "session-audit-"));
	savedHome = process.env.HOME;
	process.env.HOME = tmpRoot;
});
afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("auditSessionMembership", () => {
	it("reports a session active on more than one quest", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Bravo");
		addActiveSession(a.dir, "sess-x");
		addActiveSession(b.dir, "sess-x");

		const divergences = auditSessionMembership(state);
		expect(divergences).toHaveLength(1);
		expect(divergences[0].sessionId).toBe("sess-x");
		expect(divergences[0].questIds.sort()).toEqual([a.id, b.id].sort());
	});

	it("reports none when every session is on one quest", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		addActiveSession(a.dir, "sess-y");
		expect(auditSessionMembership(state)).toEqual([]);
	});

	it("is reachable through the session-audit verb", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const b = await createQuest(state, "Bravo");
		addActiveSession(a.dir, "sess-z");
		addActiveSession(b.dir, "sess-z");
		const result = await handle(state, fakePi(), fakeCtx(), {
			action: "session-audit",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.message).toContain("sess-z");
	});
});
