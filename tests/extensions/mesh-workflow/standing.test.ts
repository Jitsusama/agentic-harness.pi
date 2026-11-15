/**
 * What joining or leaving a group answers: where this peer stands, and
 * the group it named, never every group on a busy mesh. mesh_groups is
 * the one that lists them all.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type MeshPaths,
	meshWorkflow,
} from "../../../extensions/mesh-workflow/index.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";

const session = "01a15f3a-2255-7463-9909-afa624b025fe";
/** Enough peers, each in its own group, to make a whole listing long. */
const BUSY_MESH = 120;
/** A ceiling an answer naming one group and this peer's stand keeps under. */
const SHORT_CHARS = 600;

let root: string;
let paths: MeshPaths;
let stops: (() => Promise<void>)[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-standing-"));
	paths = {
		mesh: join(root, "mesh"),
		sessions: join(root, "sessions"),
		quests: join(root, "quests"),
	};
	mkdirSync(paths.sessions, { recursive: true });
	writeFileSync(
		join(paths.sessions, `${session}.json`),
		JSON.stringify({ quest: "QEST-20261021-7M6JKG" }),
		"utf8",
	);
	stops = [];
});

afterEach(async () => {
	for (const stop of stops) await stop();
	rmSync(root, { recursive: true, force: true });
});

type Tool = {
	execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }>;
};
type Handler = (event: unknown, ctx: unknown) => unknown;

/** Start a session on the extension, with just enough of pi for its tools. */
async function startSession(): Promise<Map<string, Tool>> {
	const tools = new Map<string, Tool>();
	const lifecycle = new Map<string, Handler>();
	const pi = {
		on: (event: string, handler: Handler) => lifecycle.set(event, handler),
		registerTool: (tool: { name: string }) =>
			tools.set(tool.name, tool as never),
		sendMessage: () => {},
		appendEntry: () => {},
		registerEntryRenderer: () => {},
		registerMessageRenderer: () => {},
		registerCommand: () => {},
		events: { on: () => {}, emit: () => {} },
	};
	meshWorkflow(paths, {}, { settleMs: 40, spreadMs: 0 })(pi as never);
	await lifecycle.get("session_start")?.(
		{ reason: "startup" },
		{
			hasUI: false,
			cwd: root,
			sessionManager: {
				getSessionId: () => session,
				getSessionFile: () => join(root, `${session}.jsonl`),
				getBranch: () => [],
				getSessionName: () => undefined,
				getCwd: () => root,
			},
		},
	);
	stops.push(async () => {
		await lifecycle.get("session_shutdown")?.({}, {});
	});
	return tools;
}

/** The fixture's quest, under 5GV2AH, so this peer has scopes. */
function onQuest(): void {
	const readme = (id: string, parent: string) =>
		`---\nid: ${id}\nkind: quest\nparent: ${parent}\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\n---\n# ${id}\n`;
	for (const [id, parent] of [
		["QEST-20261021-7M6JKG", "QEST-20261021-5GV2AH"],
		["QEST-20261021-5GV2AH", "null"],
	] as const) {
		mkdirSync(join(paths.quests, id), { recursive: true });
		writeFileSync(join(paths.quests, id, "README.md"), readme(id, parent));
	}
}

/** Many other peers, each in a group of its own, as on a busy night. */
function busyMesh(): void {
	const presences = createPresences(join(paths.mesh, "presence"));
	for (let n = 0; n < BUSY_MESH; n += 1) {
		presences.publish({
			session: `session-${n}`,
			addresses: [`PEER${String(n).padStart(2, "0")}`],
			groups: [`#work-${n}`],
			worksOn: "",
			owns: [],
			busy: false,
			at: new Date().toISOString(),
		});
	}
}

async function answered(
	tools: Map<string, Tool>,
	name: string,
	group: string,
): Promise<string> {
	const answer = await tools.get(name)?.execute("call-1", { group });
	return answer?.content[0]?.text ?? "";
}

describe("joining and leaving on a busy mesh", () => {
	it("says where this peer stands when a leave is refused, not every group", async () => {
		onQuest();
		busyMesh();
		const tools = await startSession();

		const text = await answered(tools, "mesh_leave", "#quest/5gv2ah/7m6jkg");

		expect(text, "the refusal still says why").toContain(
			"is one of this peer's scopes",
		);
		expect(text, "and where this peer stands").toContain(
			"is in #quest/5gv2ah/7m6jkg by its work",
		);
		expect(text, "it points at the full listing").toContain("mesh_groups");
		expect(text, "it lists no other peer's group").not.toContain("#work-");
		expect(text.length, "it stays short").toBeLessThan(SHORT_CHARS);
	});

	it("says only who else is in a group it joins", async () => {
		busyMesh();
		const tools = await startSession();

		const text = await answered(tools, "mesh_join", "#work-7");

		expect(text, "it names the group's members").toContain("#work-7: PEER07, ");
		expect(text, "it lists no other group").not.toContain("#work-8");
		expect(text.length, "it stays short").toBeLessThan(SHORT_CHARS);
	});

	it("says a group left, with this peer's stand", async () => {
		busyMesh();
		const tools = await startSession();
		await answered(tools, "mesh_join", "#harness");

		const text = await answered(tools, "mesh_leave", "#harness");

		expect(text, "it says what changed").toContain("Left #harness.");
		expect(text, "it lists no other peer's group").not.toContain("#work-");
		expect(text.length, "it stays short").toBeLessThan(SHORT_CHARS);
	});
});
