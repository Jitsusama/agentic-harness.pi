import { describe, expect, it } from "vitest";
import {
	kittyOpens,
	kittySocket,
	openThroughKitty,
	type Ran,
	type Run,
} from "../../../../lib/internal/links/through-terminal.ts";

const held = (terminal: string, within?: string) => async () => ({
	terminal,
	...(within ? { within } : {}),
});
const shownNowhere = async () => undefined;

describe("the kitty a link is opened through", () => {
	it("is the one pi runs under, by kitty's own variable", async () => {
		expect(
			await kittySocket(
				{ KITTY_LISTEN_ON: "unix:@kitty-1" },
				held("kitty", "unix:@kitty-2"),
			),
		).toBe("unix:@kitty-1");
	});

	it("is the one the window joined to a held session listens on", async () => {
		expect(await kittySocket({}, held("kitty", "unix:@kitty-5582"))).toBe(
			"unix:@kitty-5582",
		);
	});

	it("is none when the window is another terminal's, or there is none", async () => {
		expect(await kittySocket({}, held("ghostty", "somewhere"))).toBeUndefined();
		expect(await kittySocket({}, held("kitty"))).toBeUndefined();
		expect(await kittySocket({}, shownNowhere)).toBeUndefined();
	});
});

describe("opening a link through kitty", () => {
	async function opening(url: string, socket: string | undefined, ran: Ran) {
		const asked: string[][] = [];
		const fellBack: string[] = [];
		const run: Run = async (command, args) => {
			asked.push([command, ...args]);
			return ran;
		};
		await openThroughKitty(async () => socket, run)(url, (u) =>
			fellBack.push(u),
		);
		return { asked, fellBack };
	}

	it("asks kitty to run its open_url, so the opener gets kitty's activation token", async () => {
		const { asked, fellBack } = await opening(
			"https://example.com/a",
			"unix:@kitty-5582",
			"done",
		);
		expect(asked).toEqual([
			[
				"kitten",
				"@",
				"--to",
				"unix:@kitty-5582",
				"action",
				"open_url",
				"https://example.com/a",
			],
		]);
		expect(fellBack).toEqual([]);
	});

	it("hands kitty a backslash so it arrives as one", () => {
		expect(kittyOpens("s", "https://example.com/a\\b").at(-1)).toBe(
			"https://example.com/a\\\\b",
		);
	});

	it("leaves it to pi's opener when no kitty can be reached", async () => {
		const { asked, fellBack } = await opening(
			"https://example.com/a",
			undefined,
			"done",
		);
		expect(asked).toEqual([]);
		expect(fellBack).toEqual(["https://example.com/a"]);
	});

	it("leaves it to pi's opener when kitty refuses", async () => {
		const { asked, fellBack } = await opening(
			"file:///home/a/notes.md",
			"unix:@kitty-1",
			"refused",
		);
		expect(asked).toHaveLength(1);
		expect(fellBack).toEqual(["file:///home/a/notes.md"]);
	});

	it("opens it once when kitty doesn't answer in time, since kitty may have", async () => {
		const { asked, fellBack } = await opening(
			"https://example.com/a",
			"unix:@kitty-1",
			"no-answer",
		);
		expect(asked).toHaveLength(1);
		expect(fellBack).toEqual([]);
	});

	it("leaves it to pi's opener when asking for the window fails", async () => {
		const fellBack: string[] = [];
		await openThroughKitty(
			async () => {
				throw new Error("no node");
			},
			async () => "done",
		)("https://example.com/a", (url) => fellBack.push(url));
		expect(fellBack).toEqual(["https://example.com/a"]);
	});
});
