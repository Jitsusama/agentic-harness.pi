import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { defaultWorkspaceRoot } from "../../../extensions/quest-workflow/workspace";

let root: string;
let savedCache: string | undefined;

function fakePi() {
	return { setSessionName: () => {} } as unknown as Parameters<
		typeof handle
	>[1];
}

function fakeCtx(cwd: string) {
	return {
		cwd,
		sessionManager: { getSessionId: () => "sess-1" },
	} as unknown as Parameters<typeof handle>[2];
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "conclude-audit-"));
	savedCache = process.env.XDG_CACHE_HOME;
	process.env.XDG_CACHE_HOME = join(root, "cache");
});

afterEach(() => {
	if (savedCache === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = savedCache;
	rmSync(root, { recursive: true, force: true });
});

async function loadedQuest() {
	const state = createQuestState({ questsRoot: join(root, "quests") });
	const created = await handle(state, fakePi(), fakeCtx(root), {
		action: "create",
		title: "Record Audit",
	});
	if (!created.ok) throw new Error(created.guidance);
	const put = (rel: string, content = "x\n") => {
		const path = join(state.questDir ?? "", rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	};
	const cite = (line: string) =>
		appendFileSync(join(state.questDir ?? "", "README.md"), `\n${line}\n`);
	const conclude = () =>
		handle(state, fakePi(), fakeCtx(root), {
			action: "conclude",
			scope: "quest",
		});
	return { state, put, cite, conclude };
}

describe("concluding a quest", () => {
	it("is refused while the record holds a stray, naming where it belongs", async () => {
		const { state, put, conclude } = await loadedQuest();
		put("lab/results.csv");
		const result = await conclude();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.guidance).toContain("lab");
		expect(result.guidance).toContain(
			join(defaultWorkspaceRoot(), state.questId ?? "", "lab"),
		);
		expect(state.questStatus).toBe("active");
	});

	it("is refused while a link into attachments leads nowhere", async () => {
		const { put, cite, conclude } = await loadedQuest();
		put("attachments/notes.md", "See ![c](cost.png) and ![g](gone.png)\n");
		cite("Notes in `attachments/notes.md`.");
		const result = await conclude();
		expect(result.ok).toBe(true);

		const again = await loadedQuest();
		again.cite("![Gone](attachments/gone.png)");
		const refused = await again.conclude();
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.guidance).toContain("attachments/gone.png");
	});

	it("names uncited attachments and concludes anyway", async () => {
		const { state, put, conclude } = await loadedQuest();
		put("attachments/lonely.md");
		const result = await conclude();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.message).toContain("attachments/lonely.md");
		expect(state.questStatus).toBe("concluded");
	});
});
