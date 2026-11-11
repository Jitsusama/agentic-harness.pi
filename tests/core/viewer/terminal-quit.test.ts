/** A quit a viewer types is asked of that viewer alone before it holds. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	LEFT_RUNNING,
	type QuitVerdict,
	ViewerTerminal,
} from "../../../lib/core/viewer/terminal.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function viewer(window?: string) {
	return {
		rows: 24,
		columns: 200,
		write: vi.fn<(data: string) => void>(),
		disconnect: vi.fn<(reason: string) => void>(),
		...(window ? { window } : {}),
	};
}

const QUESTION = "Close this conversation for everyone?";
const asked = (sink: ReturnType<typeof viewer>) =>
	sink.write.mock.calls.some(([data]) => data.includes(QUESTION));

/** A screen whose Ctrl+D asks whether its quit holds, as pi's hosted quit does. */
function screen(busy = false) {
	const terminal = new ViewerTerminal("a", () => terminal.write("painted"));
	const read: string[] = [];
	const verdicts: Promise<QuitVerdict>[] = [];
	terminal.start(
		(data) => {
			if (data === "\x04") verdicts.push(terminal.confirmQuit(busy));
			else read.push(data);
		},
		() => {},
	);
	cleanups.push(() => terminal.dispose());
	return { terminal, read, verdicts };
}

/** The verdict on the first quit typed. */
function first(verdicts: Promise<QuitVerdict>[]): Promise<QuitVerdict> {
	const verdict = verdicts.at(0);
	if (!verdict) throw new Error("no quit was typed");
	return verdict;
}

describe("a quit typed in a viewer", () => {
	it("asks that viewer alone, sends it nothing more until it answers, and holds on y", async () => {
		const { terminal, read, verdicts } = screen();
		const typing = viewer("7");
		const other = viewer();
		const one = terminal.attach(typing);
		terminal.attach(other);

		one.input("\x04");
		expect(asked(typing), "the viewer that typed it is asked").toBe(true);
		expect(asked(other), "nobody else is asked").toBe(false);
		expect(
			typing.write.mock.calls.at(-1)?.[0],
			"it says who else is watching",
		).toContain("1 other viewer is watching.");
		typing.write.mockClear();
		terminal.write("a frame");
		expect(
			typing.write,
			"a frame would draw over the question",
		).not.toHaveBeenCalled();
		expect(other.write, "the others still see the screen").toHaveBeenCalledWith(
			"a frame",
		);

		one.input("y");
		const verdict = await first(verdicts);
		expect(verdict.holds, "y closes it").toBe(true);
		expect(verdict.holds && verdict.by, "it names the viewer").toMatch(
			/^viewer 1 in window 7, joined \d{4}-\d\d-\d\dT/,
		);
		expect(read, "pi never read the answer").toEqual([]);
	});

	it("lets that viewer go and leaves the conversation running on any other key", async () => {
		const { terminal, read, verdicts } = screen(true);
		const typing = viewer();
		const other = viewer();
		const one = terminal.attach(typing);
		const two = terminal.attach(other);

		one.input("\x04");
		expect(
			typing.write.mock.calls.at(-1)?.[0],
			"it says a turn is running",
		).toContain("A turn is running.");
		one.input("n");

		expect(await first(verdicts), "the quit doesn't hold").toEqual({
			holds: false,
		});
		expect(typing.disconnect, "that viewer is let go").toHaveBeenCalledWith(
			LEFT_RUNNING,
		);
		expect(other.disconnect, "the other stays").not.toHaveBeenCalled();
		two.input("still here");
		// pi's stdin buffer hands it each key alone, so read them joined.
		expect(read.join(""), "pi reads the other viewer, not the answer").toBe(
			"still here",
		);
	});

	it("asks a lone viewer too, since a key can come from no person, and Ctrl+D again holds", async () => {
		const { terminal, verdicts } = screen();
		const alone = viewer();
		const one = terminal.attach(alone);

		one.input("\x04");
		expect(asked(alone), "even alone, it asks").toBe(true);
		one.input("\x1b[100;1:3u");
		expect(verdicts, "a key's release is no answer").toHaveLength(1);
		one.input("\x04");

		expect((await first(verdicts)).holds, "Ctrl+D again closes it").toBe(true);
	});

	it("doesn't hold when the asked viewer leaves before it answers, or the conversation closes", async () => {
		const { terminal, verdicts } = screen();
		const leaving = terminal.attach(viewer());
		const staying = viewer();
		const two = terminal.attach(staying);

		leaving.input("\x04");
		leaving.detach();
		two.input("\x04");
		terminal.dispose();

		expect(
			await Promise.all(verdicts),
			"a window closing or a close elsewhere is no yes",
		).toEqual([{ holds: false }, { holds: false }]);
	});

	it("holds at once when no viewer's key asked for it", async () => {
		const { terminal } = screen();
		const watching = viewer();
		terminal.attach(watching);

		expect(
			await terminal.confirmQuit(false),
			"an extension's shutdown is the conversation's own",
		).toEqual({
			holds: true,
			by: "the conversation itself, with no viewer's key",
		});
		expect(asked(watching), "nobody is asked").toBe(false);
	});
});
