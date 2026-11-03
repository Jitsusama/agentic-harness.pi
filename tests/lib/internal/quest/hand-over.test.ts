import { describe, expect, it } from "vitest";
import {
	handOver,
	launcherTakes,
	takenBy,
} from "../../../../lib/internal/quest/hand-over";

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
		expect(sent[0]?.startsWith("{")).toBe(true);
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

	it("asks nothing when there is nothing to hand over", async () => {
		let asked = false;
		const taken = await handOver([], async () => {
			asked = true;
			return "taken";
		});
		expect(taken).toBeUndefined();
		expect(asked).toBe(false);
	});

	it("reads how many the launcher's answer says it took", () => {
		expect(takenBy("taken", 3)).toBe(3);
		expect(takenBy("taken 2 of 3", 3)).toBe(2);
		expect(takenBy("taken 0 of 3", 3)).toBeUndefined();
		expect(takenBy("refused: not a list of sessions", 3)).toBeUndefined();
		expect(takenBy("", 3)).toBeUndefined();
	});

	it("gives only what the launcher would take as given", () => {
		expect(launcherTakes({ id: "01a1-x_y.z", cwd: "/w" })).toBe(true);
		expect(launcherTakes({ id: "a b", cwd: "/w" })).toBe(false);
		expect(launcherTakes({ id: "a", cwd: "w" })).toBe(false);
	});
});
