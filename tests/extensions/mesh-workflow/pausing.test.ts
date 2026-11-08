/**
 * Pause, Resume, Stop and Close from outside a session's window.
 */
import { describe, expect, it } from "vitest";
import {
	createPausing,
	type Pausing,
} from "../../../extensions/mesh-workflow/pausing.ts";

interface Session {
	idle: boolean;
	readonly pausing: Pausing;
	readonly did: string[];
	readonly told: string[];
}

function session(
	idle: boolean,
	carry: (to: string) => Promise<void> = async () => {},
): Session {
	const did: string[] = [];
	const told: string[] = [];
	let paused = false;
	const state = { idle };
	const at: Session = {
		get idle() {
			return state.idle;
		},
		set idle(now) {
			state.idle = now;
		},
		pausing: createPausing({
			idle: (): boolean => state.idle,
			abort: () => did.push("abort"),
			paused: () => paused,
			setPaused: (now) => {
				paused = now;
			},
			carryOn: () => did.push("carry on"),
			tell: (text) => told.push(text),
			close: () => did.push("close"),
			carry: async (to) => {
				did.push(`carry to ${to}`);
				await carry(to);
			},
		}),
		did,
		told,
	};
	return at;
}

describe("pausing a session", () => {
	it("lets the turn under way finish, then ends every run until resumed", () => {
		const one = session(false);
		one.pausing.act("pause");
		expect(one.did).toEqual([]);
		one.pausing.turnEnded();
		expect(one.did).toEqual(["abort"]);

		one.idle = true;
		one.pausing.turnEnded();
		one.pausing.started();
		expect(one.did).toEqual(["abort", "abort"]);
		expect(one.pausing.paused).toBe(true);

		one.pausing.act("resume");
		expect(one.pausing.paused).toBe(false);
		expect(one.did).toEqual(["abort", "abort", "carry on"]);
		one.pausing.started();
		expect(one.did).toHaveLength(3);
	});

	it("ends with a talk, or the person typing in the window, whose words are the turn", () => {
		const one = session(true);
		one.pausing.act("pause");
		one.pausing.talked();
		one.pausing.started();
		expect(one.pausing.paused).toBe(false);
		expect(one.did).toEqual([]);
	});

	it("resumes nothing that was not paused", () => {
		const one = session(true);
		one.pausing.act("resume");
		expect(one.did).toEqual([]);
	});
});

describe("stopping a session", () => {
	it("ends the run in progress at once and leaves it listening, unpaused", () => {
		const one = session(false);
		one.pausing.act("pause");
		one.pausing.act("stop");
		expect(one.did).toEqual(["abort"]);
		expect(one.pausing.paused).toBe(false);

		const idle = session(true);
		idle.pausing.act("stop");
		expect(idle.did).toEqual([]);
	});
});

describe("closing a session", () => {
	it("ends the run in progress, then the session, as /exit does", () => {
		const busy = session(false);
		busy.pausing.act("close");
		expect(busy.did).toEqual(["abort", "close"]);

		const idle = session(true);
		idle.pausing.act("close");
		expect(idle.did).toEqual(["close"]);
	});
});

describe("carrying a session to another machine", () => {
	it("ends the run in progress, carries its work, then closes it", async () => {
		const busy = session(false);
		await busy.pausing.carry("penelope");
		expect(busy.did).toEqual(["abort", "carry to penelope", "close"]);

		const idle = session(true);
		await idle.pausing.carry("penelope");
		expect(idle.did).toEqual(["carry to penelope", "close"]);
	});

	it("ends any run that starts once its work is being carried", async () => {
		let carried = () => {};
		const one = session(
			true,
			() =>
				new Promise((done) => {
					carried = done;
				}),
		);

		const carrying = one.pausing.carry("penelope");
		one.pausing.started();
		carried();
		await carrying;

		expect(one.did).toEqual(["carry to penelope", "abort", "close"]);
		one.pausing.started();
		expect(one.did.at(-1), "and while pi winds down to close").toBe("abort");
	});

	it("stays open and says why when its work could not be carried", async () => {
		const one = session(true, async () => {
			throw new Error("the scratch folder can't be written");
		});

		await one.pausing.carry("penelope");

		expect(one.did).toEqual(["carry to penelope"]);
		expect(one.told.at(-1)).toContain("the scratch folder can't be written");
		one.pausing.started();
		expect(one.did, "and goes on working as it was").toHaveLength(1);
	});
});
