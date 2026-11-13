import { describe, expect, it } from "vitest";
import {
	askLauncher,
	handOver,
	launcherTakes,
	takenBy,
} from "../../../../lib/internal/quest/hand-over.ts";

describe("handing sessions to the launcher", () => {
	it("sends them as an object listing each id and folder", async () => {
		// qs ipc call doesn't pass an argument starting with `[` whole.
		const sent: string[] = [];
		const taken = await handOver(
			[
				{ id: "01a1-one", cwd: "/work/one" },
				{ id: "01a1-two", cwd: "/work/two" },
			],
			async (argument) => {
				sent.push(argument);
				return "taken\n";
			},
		);
		expect(taken).toBe(2);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatch(/^\{/);
		expect(JSON.parse(sent[0] ?? "")).toEqual({
			sessions: [
				{ id: "01a1-one", cwd: "/work/one", focus: false },
				{ id: "01a1-two", cwd: "/work/two", focus: false },
			],
		});
	});

	it("asks for each without focus, where its quest's sessions are or beside the one that asked", async () => {
		// Joel, 2 November: windows sessions opened took his keys, so the
		// launcher focuses only what his own press opens.
		const sent: string[] = [];
		await handOver(
			[{ id: "01a1-one", cwd: "/w", quest: "QEST-1", from: "01a1-me" }],
			async (argument) => {
				sent.push(argument);
				return "taken";
			},
		);
		expect(JSON.parse(sent[0] ?? "")).toEqual({
			sessions: [
				{
					id: "01a1-one",
					cwd: "/w",
					quest: "QEST-1",
					from: "01a1-me",
					focus: false,
				},
			],
		});
	});

	it("says the orchestrator and the title its window is placed by", async () => {
		// 8 November: a session spawned for 91DWO8 by WCJQSG opened on
		// WCJQSG's workspace, since the launcher knew only who asked.
		const sent: string[] = [];
		await handOver(
			[
				{
					id: "01a1-one",
					cwd: "/w",
					quest: "QEST-1",
					orchestratedBy: "91DWO8",
					workspace: "WCJQSG",
					title: "Edge Checks",
				},
			],
			async (argument) => {
				sent.push(argument);
				return "taken";
			},
		);
		expect(JSON.parse(sent[0] ?? "")).toEqual({
			sessions: [
				{
					id: "01a1-one",
					cwd: "/w",
					quest: "QEST-1",
					orchestratedBy: "91DWO8",
					workspace: "WCJQSG",
					title: "Edge Checks",
					focus: false,
				},
			],
		});
	});

	it("says whose place a restarted session takes, and the model it runs on", async () => {
		const sent: string[] = [];
		await handOver(
			[
				{
					id: "01a1-back",
					cwd: "/w",
					from: "01a1-me",
					replaces: "01a1-back",
					model: "anthropic/claude-opus-5-5:high",
				},
			],
			async (argument) => {
				sent.push(argument);
				return "taken";
			},
		);
		expect(JSON.parse(sent[0] ?? "")).toEqual({
			sessions: [
				{
					id: "01a1-back",
					cwd: "/w",
					from: "01a1-me",
					replaces: "01a1-back",
					model: "anthropic/claude-opus-5-5:high",
					focus: false,
				},
			],
		});
	});

	it("says what a session was started with, for the launcher to start it so again", async () => {
		const sent: string[] = [];
		await handOver(
			[{ id: "01a1-back", cwd: "/w", env: { PI_SANDBOX: "fence" } }],
			async (argument) => {
				sent.push(argument);
				return "taken";
			},
		);
		expect(JSON.parse(sent[0] ?? "")).toEqual({
			sessions: [
				{
					id: "01a1-back",
					cwd: "/w",
					env: { PI_SANDBOX: "fence" },
					focus: false,
				},
			],
		});
	});

	it("hands over two sessions asked for at once, each in its own call", async () => {
		// Y2YBTS [51dbc285], 2026-11-04: two spawns 0.4 s apart both said
		// they were handed over, and the shell logged both; only one opened.
		// Neither call waits on the other or shares what it sends.
		const sent: string[] = [];
		let answerBoth: () => void = () => {};
		const bothAsked = new Promise<void>((resolve) => {
			answerBoth = resolve;
		});
		const launcher = async (argument: string) => {
			sent.push(argument);
			if (sent.length === 2) answerBoth();
			await bothAsked;
			return "taken\n";
		};
		const taken = await Promise.all([
			handOver(
				[{ id: "01a1-one", cwd: "/w", fresh: true, quest: "QEST-1" }],
				launcher,
			),
			handOver(
				[{ id: "01a1-two", cwd: "/w", fresh: true, quest: "QEST-2" }],
				launcher,
			),
		]);
		expect(taken).toEqual([1, 1]);
		const ids = sent.map((one) =>
			(JSON.parse(one) as { sessions: { id: string }[] }).sessions.map(
				(s) => s.id,
			),
		);
		expect(ids).toEqual([["01a1-one"], ["01a1-two"]]);
	});

	it("takes none when the launcher refuses or isn't running", async () => {
		const session = [{ id: "s", cwd: "/w" }];
		expect(
			await handOver(session, async () => "refused: no session with an id"),
		).toBeUndefined();
		expect(
			await handOver(session, async () => {
				throw new Error('No running instances for "shell.qml"');
			}),
		).toBeUndefined();
	});

	// 11-10 13:28: the shell was too busy to answer in time, and the
	// spawns that took that as a no opened windows of their own while
	// the call still sat with it (Y2YBTS [9f93dcd0]).
	it("leaves sessions with a launcher whose shell never answered, as taken", async () => {
		const session = [
			{ id: "s", cwd: "/w" },
			{ id: "t", cwd: "/w" },
		];
		const busy = async (): Promise<string> => {
			throw Object.assign(new Error("Command failed: qs"), { killed: true });
		};
		expect(await askLauncher(session, busy)).toBe("unanswered");
		expect(await handOver(session, busy)).toBe(2);
		expect(
			await askLauncher(session, async () => "refused: no session with an id"),
		).toBe("untaken");
		expect(await askLauncher(session, async () => "taken")).toEqual({
			taken: 2,
		});
	});

	it("asks nothing when there is nothing to hand over", async () => {
		let asked = false;
		const taken = await handOver([], async () => {
			asked = true;
			return "taken";
		});
		expect(taken).toBeUndefined();
		expect(asked, "the launcher is not asked to take no sessions").toBe(false);
	});

	it("reads how many the launcher's answer says it took", () => {
		expect(takenBy("taken", 3)).toBe(3);
		expect(takenBy("taken 2 of 3", 3)).toBe(2);
		expect(takenBy("taken 0 of 3", 3)).toBeUndefined();
		expect(takenBy("refused: not a list of sessions", 3)).toBeUndefined();
		expect(takenBy("", 3)).toBeUndefined();
	});

	it("gives only what the launcher would take as given", () => {
		expect(
			launcherTakes({ id: "01a1-x_y.z", cwd: "/w" }),
			"an id of word characters, dashes and dots in an absolute folder is taken",
		).toBe(true);
		expect(
			launcherTakes({ id: "a b", cwd: "/w" }),
			"an id holding a space is not taken",
		).toBe(false);
		expect(
			launcherTakes({ id: "a", cwd: "w" }),
			"a relative folder is not taken",
		).toBe(false);
	});
});
