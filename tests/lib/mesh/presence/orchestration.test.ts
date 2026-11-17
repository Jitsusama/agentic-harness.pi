/**
 * This session's peer in an orchestration: whom it answers to, which
 * groups it is in, and what its quest asks of it there.
 */
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	parseQuestFrontMatter,
	serializeQuestFrontMatter,
} from "../../../../lib/internal/quest/documents/frontmatter.ts";
import { localPeer } from "../../../../lib/mesh/peer.ts";
import { createPresences } from "../../../../lib/mesh/presence.ts";
import { wantId } from "../../../../lib/mesh/want.ts";
import { presence, session, surroundingsAt } from "./support/presences.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-presence-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("this session's peer", () => {
	const surroundings = () => surroundingsAt(root);

	describe("in an orchestration", () => {
		const MISSION = "QEST-20261007-WCJQSG";
		const SWARM = "QEST-20261026-SWARM1";
		const LOOP = "QEST-20261025-QCXZEB";
		const readme = (id: string, parent: string, marked = false) =>
			`---\nid: ${id}\nkind: ${parent === "null" ? "quest" : "subquest"}\nparent: ${parent}\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-25\nupdated: 2026-10-25\n${marked ? "orchestrator: true\n" : ""}---\n# ${id}\n`;
		const write = (quests: [string, string][], loaded: string) => {
			for (const [id, text] of quests) {
				mkdirSync(join(root, "quests", id), { recursive: true });
				writeFileSync(join(root, "quests", id, "README.md"), text);
			}
			mkdirSync(join(root, "sessions"), { recursive: true });
			writeFileSync(
				join(root, "sessions", `${session}.json`),
				JSON.stringify({ quest: loaded }),
			);
		};

		it("sees a parent start orchestrating, though its README kept its old times", () => {
			// A README's parse is kept while the file is unchanged; one written
			// again with its old modification time is still read afresh.
			const long = new Date(Date.now() - 3_600_000);
			const age = (id: string) =>
				utimesSync(join(root, "quests", id, "README.md"), long, long);
			write(
				[
					[MISSION, readme(MISSION, "null")],
					[LOOP, readme(LOOP, MISSION)],
				],
				LOOP,
			);
			age(MISSION);
			age(LOOP);
			const peer = localPeer(surroundings());
			expect(peer.orchestratedBy).toBeUndefined();

			writeFileSync(
				join(root, "quests", MISSION, "README.md"),
				readme(MISSION, "null", true),
			);
			age(MISSION);
			peer.refresh();

			expect(peer.orchestratedBy).toBe("WCJQSG");
		});

		it("joins the orchestration's group and names its orchestrator, found up the tree", () => {
			write(
				[
					[MISSION, readme(MISSION, "null", true)],
					[LOOP, readme(LOOP, MISSION)],
				],
				LOOP,
			);
			const at = surroundings();

			const peer = localPeer(at);

			expect(peer.scopes).toEqual([
				"#orchestration/wcjqsg",
				"#quest/wcjqsg/qcxzeb",
			]);
			expect(peer.orchestratedBy).toBe("WCJQSG");
			expect(peer.orchestrates).toBeUndefined();
			expect(createPresences(join(root, "presence")).of(session)).toMatchObject(
				{ orchestratedBy: "WCJQSG" },
			);
		});

		it("names the workspace its window opens on: the topmost orchestrator's, by address", () => {
			write(
				[
					[MISSION, readme(MISSION, "null", true)],
					[SWARM, readme(SWARM, MISSION, true)],
					[LOOP, readme(LOOP, SWARM)],
				],
				LOOP,
			);

			const peer = localPeer(surroundings());

			expect(
				[
					peer.orchestratedBy,
					createPresences(join(root, "presence")).of(session)?.workspace,
				],
				"answers to the nearest, opens beside the topmost",
			).toEqual(["SWARM1", "WCJQSG"]);
		});

		it("hears only what is put to it while its quest says so", () => {
			write(
				[
					[MISSION, readme(MISSION, "null", true)],
					[LOOP, readme(LOOP, MISSION)],
				],
				LOOP,
			);
			const peer = localPeer(surroundings());
			const before = peer.receiver.hears;
			writeFileSync(
				join(root, "quests", LOOP, "README.md"),
				readme(LOOP, MISSION).replace("---\n#", "hears: addressed\n---\n#"),
			);
			peer.refresh();

			expect(
				[before, peer.receiver.hears, peer.orchestratedBy],
				"everything, then only what is put to it, still orchestrated",
			).toEqual([undefined, "addressed", "WCJQSG"]);
		});

		it("stands at the launcher's top while its quest says so, under the name it gives", () => {
			write([[LOOP, readme(LOOP, "null")]], LOOP);
			const peer = localPeer(surroundings());
			const kept = createPresences(join(root, "presence"));
			const before = Object.keys(kept.of(session) ?? {});
			writeFileSync(
				join(root, "quests", LOOP, "README.md"),
				readme(LOOP, "null").replace(
					"---\n#",
					"stands-at-top: {name: The Void, keywords: [void]}\n---\n#",
				),
			);
			peer.refresh();

			expect(
				[before.includes("standsAtTop"), kept.of(session)?.standsAtTop],
				"left out until its quest says it, then kept as said",
			).toEqual([false, { name: "The Void", keywords: ["void"] }]);
		});

		it("still stands at the top after the workflow rewrites its README", () => {
			const said = readme(LOOP, "null").replace(
				"---\n#",
				"stands-at-top: {name: The Void, keywords: [void]}\n---\n#",
			);
			const parsed = parseQuestFrontMatter(said);
			if (!parsed) throw new Error("the README should parse");
			write(
				[
					[
						LOOP,
						`${serializeQuestFrontMatter(parsed.frontMatter)}\n${parsed.body}`,
					],
				],
				LOOP,
			);
			localPeer(surroundings());

			expect(
				createPresences(join(root, "presence")).of(session)?.standsAtTop,
			).toEqual({ name: "The Void", keywords: ["void"] });
		});

		it("says what it is for at the top when its quest gives a sentence", () => {
			write(
				[
					[
						LOOP,
						readme(LOOP, "null").replace(
							"---\n#",
							"stands-at-top: {name: The Void, keywords: [void], what: ' Say it once. '}\n---\n#",
						),
					],
				],
				LOOP,
			);
			localPeer(surroundings());

			expect(
				createPresences(join(root, "presence")).of(session)?.standsAtTop,
			).toEqual({ name: "The Void", keywords: ["void"], what: "Say it once." });
		});

		it("stands nowhere when its quest names no one to stand as", () => {
			write(
				[
					[
						LOOP,
						readme(LOOP, "null").replace(
							"---\n#",
							"stands-at-top: {keywords: [void]}\n---\n#",
						),
					],
				],
				LOOP,
			);
			localPeer(surroundings());

			expect(
				Object.keys(createPresences(join(root, "presence")).of(session) ?? {}),
			).not.toContain("standsAtTop");
		});

		it("says the quest it has loaded, by id, and none while it has none", () => {
			write([[LOOP, readme(LOOP, "null")]], LOOP);
			const at = surroundings();

			localPeer(at);

			expect(at.presences.of(session)?.quest).toBe(LOOP);

			writeFileSync(
				join(root, "sessions", `${session}.json`),
				JSON.stringify({}),
			);
			localPeer(at);

			expect(at.presences.of(session)?.quest).toBeUndefined();
		});

		it("keeps a question its run ends on for its orchestrator, and still shows an approval", () => {
			write(
				[
					[MISSION, readme(MISSION, "null", true)],
					[LOOP, readme(LOOP, MISSION)],
				],
				LOOP,
			);
			const peer = localPeer(surroundings());
			const since = new Date(0).toISOString();

			peer.want({
				id: wantId("question", since),
				kind: "question",
				since,
				said: "Shall I merge it?",
			});
			expect(peer.wants).toBeUndefined();

			peer.want({
				id: wantId("approval", since),
				kind: "approval",
				since,
				said: "git push",
			});
			expect(peer.wants).toMatchObject({ kind: "approval" });
		});

		it("lists every want standing, saying the question is its orchestrator's", () => {
			write(
				[
					[MISSION, readme(MISSION, "null", true)],
					[LOOP, readme(LOOP, MISSION)],
				],
				LOOP,
			);
			const at = surroundings();
			const peer = localPeer(at);
			const asked = "2026-11-06T22:00:00.000Z";
			const held = "2026-11-06T22:05:00.000Z";

			peer.want({
				id: wantId("question", asked),
				kind: "question",
				since: asked,
				said: "Shall I merge it?",
			});
			expect(at.presences.of(session)).toMatchObject({
				state: "listening",
				wanting: [{ kind: "question", forPerson: false }],
			});
			expect(at.presences.of(session)?.wants).toBeUndefined();

			peer.want({
				id: wantId("approval", held),
				kind: "approval",
				since: held,
				said: "git push",
			});
			expect(at.presences.of(session)).toMatchObject({
				state: "waiting",
				wants: { kind: "approval" },
				wanting: [
					{
						id: wantId("question", asked),
						kind: "question",
						forPerson: false,
					},
					{ id: wantId("approval", held), kind: "approval", forPerson: true },
				],
			});

			peer.settle("question");
			peer.settle("approval");
			expect(at.presences.of(session)?.wanting).toBeUndefined();
		});

		it("heads its own orchestration as a member of the one above", () => {
			write(
				[
					[MISSION, readme(MISSION, "null", true)],
					[SWARM, readme(SWARM, MISSION, true)],
				],
				SWARM,
			);
			const at = surroundings();

			const peer = localPeer(at);

			expect(peer.scopes).toEqual([
				"#orchestration/swarm1",
				"#orchestration/wcjqsg",
				"#quest/wcjqsg/swarm1",
			]);
			expect(at.presences.of(session)).toMatchObject({
				orchestratedBy: "WCJQSG",
				orchestrates: "SWARM1",
			});
		});

		it("leaves the role to the session already signing with the quest's address", () => {
			write([[MISSION, readme(MISSION, "null", true)]], MISSION);
			const at = surroundings();
			at.presences.publish({
				...presence({
					session: "00000000-0000-0000-0000-000000000001",
					addresses: ["WCJQSG", "00000001"],
				}),
				orchestrates: "WCJQSG",
			});

			const peer = localPeer(at);

			expect(peer.signature).not.toBe("WCJQSG");
			expect(peer.orchestrates).toBeUndefined();
			expect(peer.scopes).toContain("#orchestration/wcjqsg");
		});
	});
});
