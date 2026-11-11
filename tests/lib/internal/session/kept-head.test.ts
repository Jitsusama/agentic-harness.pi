/**
 * The head a session keeps, worked out as its branch grows rather than
 * from the whole branch at every request: it agrees with the whole
 * branch's answer, and reads only what was appended since it last said.
 */

import type { SystemMessage, Tool } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { keptHeadOf } from "../../../../lib/internal/session/first-head.ts";
import { keptHeadAt } from "../../../../lib/internal/session/kept-head.ts";

const tool = (name: string): Tool => ({
	name,
	description: `The ${name} tool.`,
	parameters: Type.Object({}),
});

/** A head whose skills section is most of it, as a real session's is. */
const big: SystemMessage = {
	role: "system",
	content: "You are pi.",
	sections: { skills: "s".repeat(1_000) },
	toolsAdded: [tool("read")],
	timestamp: 1,
};

/** `big` with a notes section as long as itself, which a compaction moves to. */
const grown: SystemMessage = {
	...big,
	sections: { ...big.sections, notes: "n".repeat(2_000) },
	timestamp: 5,
};

interface Entry {
	readonly id: string;
	readonly parentId: string | null;
	readonly type: string;
	readonly message?: unknown;
	readonly systemMessage?: unknown;
}

/** A session as pi's manager holds one, counting the entries read from it. */
function session() {
	const byId = new Map<string, Entry>();
	let leaf: string | null = null;
	let next = 0;
	const manager = {
		reads: 0,
		getLeafId: () => leaf,
		getEntry(id: string) {
			manager.reads += 1;
			return byId.get(id);
		},
	};
	return {
		manager,
		append(entry: Omit<Entry, "id" | "parentId">): string {
			next += 1;
			const id = `e${next}`;
			byId.set(id, { ...entry, id, parentId: leaf });
			leaf = id;
			return id;
		},
		moveTo(id: string) {
			leaf = id;
		},
		branch(): Entry[] {
			const path: Entry[] = [];
			let at = leaf === null ? undefined : byId.get(leaf);
			while (at) {
				path.unshift(at);
				at = at.parentId === null ? undefined : byId.get(at.parentId);
			}
			return path;
		},
	};
}

const said = (text: string) => ({
	type: "message",
	message: { role: "user", content: text, timestamp: 0 },
});

describe("the head a session keeps, as its branch grows", () => {
	it("agrees with the whole branch's answer after each entry, through a compaction that moves it", () => {
		const s = session();
		const answers: [unknown, unknown][] = [];
		for (const entry of [
			said("hi"),
			{ type: "message", message: big },
			said("on"),
			{ type: "compaction", systemMessage: grown },
			said("after"),
		]) {
			s.append(entry);
			answers.push([keptHeadAt(s.manager), keptHeadOf(s.branch())]);
		}

		for (const [grownWay, wholeWay] of answers) expect(grownWay).toBe(wholeWay);
		expect(answers.at(-1)?.[0], "the compaction moved it").toBe(grown);
	});

	it("reads only what was appended since it last answered", () => {
		const s = session();
		s.append({ type: "message", message: big });
		for (let turn = 0; turn < 50; turn++) s.append(said(`turn ${turn}`));
		keptHeadAt(s.manager);
		s.manager.reads = 0;
		s.append(said("one more"));
		s.append(said("and another"));

		expect(keptHeadAt(s.manager)).toBe(big);
		expect(s.manager.reads).toBe(2);
	});

	it("reads nothing while the leaf stays where it was", () => {
		const s = session();
		s.append({ type: "message", message: big });
		s.append(said("on"));
		keptHeadAt(s.manager);
		s.manager.reads = 0;

		expect(keptHeadAt(s.manager)).toBe(big);
		expect(s.manager.reads).toBe(0);
	});

	it("starts from the root again on a branch that leaves the one it answered for", () => {
		const s = session();
		const head = s.append({ type: "message", message: big });
		s.append({ type: "compaction", systemMessage: grown });
		s.append(said("on the first branch"));
		expect(keptHeadAt(s.manager)).toBe(grown);

		s.moveTo(head);
		s.append(said("on another branch"));

		expect(keptHeadAt(s.manager)).toBe(big);
	});

	it("keeps no head for a session with nothing in it", () => {
		expect(keptHeadAt(session().manager)).toBeUndefined();
	});
});
