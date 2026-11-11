/**
 * A parked conversation's screen: pi's screen stops, its viewers stay and
 * are told it is parked, and what they type wakes it and reaches the
 * screen it wakes into, in order, none of it lost.
 */
import { describe, expect, it, vi } from "vitest";
import {
	type HostedMode,
	type HostedModeOptions,
	hostScreens,
	PARKED_LINE,
} from "../../../host/screen/screens.ts";

/** pi's hosted screen as a park reaches it: it starts reading keys, and its shutdown stops them. */
class ReadingMode implements HostedMode {
	readonly ui = { requestRender: vi.fn() };
	/** What this screen read of its viewers' keys. */
	readonly read: string[] = [];
	readonly options: HostedModeOptions;

	constructor(options: HostedModeOptions) {
		this.options = options;
	}
	init(): Promise<void> {
		this.options.terminal.start(
			(data) => this.read.push(data),
			() => {},
		);
		return Promise.resolve();
	}
	run(): Promise<void> {
		return new Promise(() => {});
	}
	readonly shutdown = vi.fn(async () => {
		this.options.terminal.stop();
	});
}

function host() {
	const modes: ReadingMode[] = [];
	const screens = hostScreens({
		create: (_runtime, options) => {
			const mode = new ReadingMode(options);
			modes.push(mode);
			return mode;
		},
		report: vi.fn(),
	});
	const open = async (sessionId: string) => {
		await screens.screens.opened({
			sessionId,
			runtime: { sessionId },
			close: async () => {},
		});
		const mode = modes.at(-1);
		if (!mode) throw new Error(`no screen for ${sessionId}`);
		return mode;
	};
	return { ...screens, open };
}

function sink() {
	return {
		write: vi.fn(),
		disconnect: vi.fn(),
		edit: vi.fn(),
		suspend: vi.fn(),
	};
}

const attach = (sessionId: string) =>
	({
		v: 1,
		id: "r1",
		op: "attach",
		sessionId,
		rows: 40,
		columns: 120,
	}) as const;

/** Everything a viewer was sent, as one string. */
const sent = (viewer: ReturnType<typeof sink>) =>
	viewer.write.mock.calls.map(([data]) => String(data)).join("");

describe("a parked conversation's screen", () => {
	it("stops pi's screen, keeps its viewers, and says it is parked", async () => {
		const screens = host();
		const first = await screens.open("a");
		const watching = sink();
		screens.viewer.attach(attach("a"), watching);

		await screens.screens.parked("a", () => Promise.resolve());

		expect(first.shutdown, "pi's screen stopped").toHaveBeenCalledOnce();
		expect(watching.disconnect, "its viewer stays").not.toHaveBeenCalled();
		expect(sent(watching), "its viewer is told it is parked").toContain(
			PARKED_LINE,
		);
		const late = sink();
		screens.viewer.attach(attach("a"), late);
		expect(sent(late), "a viewer joining it is told too").toContain(
			PARKED_LINE,
		);
	});

	it("wakes at a key and hands every key typed until then to the screen it wakes into", async () => {
		const screens = host();
		const first = await screens.open("a");
		const attached = screens.viewer.attach(attach("a"), sink());
		const wake = vi.fn(() => Promise.resolve());
		await screens.screens.parked("a", wake);

		attached.input("wake ");
		attached.input("up");
		expect(
			wake,
			"the first key asked for the wake, once",
		).toHaveBeenCalledOnce();
		const next = await screens.open("a");
		attached.input("!");

		expect(first.read, "the screen that parked read none of it").toEqual([]);
		expect(next, "it woke into a new screen").not.toBe(first);
		// pi's stdin buffer splits what it reads into keys, so read them joined.
		expect(
			next.read.join(""),
			"the woken screen read every key, in order",
		).toBe("wake up!");
		expect(wake, "awake, a key asks for no wake").toHaveBeenCalledOnce();
	});

	it("closed while parked, lets its viewers go", async () => {
		const screens = host();
		await screens.open("a");
		const watching = sink();
		screens.viewer.attach(attach("a"), watching);
		await screens.screens.parked("a", () => Promise.resolve());

		await screens.screens.closed("a");

		expect(watching.disconnect, "its viewer is let go").toHaveBeenCalledOnce();
		expect(
			() => screens.viewer.attach(attach("a"), sink()),
			"a closed conversation has no screen to join",
		).toThrow();
	});

	it("leaves the host free to restart while every conversation is parked", async () => {
		const screens = host();
		await screens.open("a");
		await screens.screens.parked("a", () => Promise.resolve());

		expect(screens.resting(), "a parked conversation is at rest").toBe(true);
	});
});
