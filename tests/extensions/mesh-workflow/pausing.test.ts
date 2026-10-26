/**
 * Pause, Resume and Stop from outside a session's window.
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
}

function session(idle: boolean): Session {
	const did: string[] = [];
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
			tell: () => {},
		}),
		did,
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

	it("ends with a talk, whose words are the turn", () => {
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
