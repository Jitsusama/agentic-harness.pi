/**
 * Machine holds crossing into the machine's other realms, in a fixed
 * form, so a switch reaches every session without any realm's words
 * reaching another.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CROSSING_END_TEXT,
	CROSSING_HOLD_TEXT,
	type Crossings,
	cross,
	MACHINE_SENDER,
} from "../../../lib/mesh/crossing.ts";
import { ALL } from "../../../lib/mesh/group.ts";
import type { Message } from "../../../lib/mesh/message.ts";
import {
	folderTransport,
	type Transport,
} from "../../../lib/mesh/transport.ts";

let root: string;
let work: Transport;
let personal: Transport;
let crossings: Crossings;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "crossing-"));
	work = folderTransport(join(root, "work", "messages"));
	personal = folderTransport(join(root, "personal", "messages"));
	crossings = {
		others: () => [{ dir: join(root, "personal"), transport: personal }],
		notes: join(root, "work", "crossings"),
		pid: 4242,
	};
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const SECRET =
	"switching optimus now (core e51cf873: World #2337203, the Shopify zone)";

/** Send on the work mesh, as a peer there does, and cross what it sent. */
function sent(draft: Omit<Message, "v" | "id" | "at">): Message {
	const message = work.send(draft);
	cross(message, crossings, (id) => work.read(id));
	return message;
}

const personalMessages = () =>
	personal.ids().map((id) => personal.read(id) as Message);

describe("a machine hold crossing realms", () => {
	it("reaches the other realm as a hold carrying none of its sender's words", () => {
		sent({ from: "16V6F4", to: [ALL], intent: "hold", text: SECRET, pid: 7 });

		const [mirror, ...rest] = personalMessages();
		expect(rest).toEqual([]);
		expect(mirror).toMatchObject({
			from: MACHINE_SENDER,
			to: [ALL],
			intent: "hold",
			text: CROSSING_HOLD_TEXT,
			pid: 4242,
		});
		// The check that no free text crosses: every field the far realm
		// reads is fixed or the mesh's own, and none is the sender's.
		const crossed = JSON.stringify(mirror);
		for (const word of ["16V6F4", "optimus", "e51cf873", "Shopify", "World"]) {
			expect(crossed).not.toContain(word);
		}
	});

	it("ends there when its holder answers it here, in fixed words too", () => {
		const hold = sent({
			from: "16V6F4",
			to: [ALL],
			intent: "hold",
			text: SECRET,
			pid: 7,
		});
		sent({
			from: "16V6F4",
			to: [ALL],
			intent: "fyi",
			text: "the switch is done (lrgp11ms); nothing failed",
			pid: 7,
			re: hold.id,
		});

		const [mirror, end] = personalMessages();
		expect(end).toMatchObject({
			from: MACHINE_SENDER,
			intent: "fyi",
			text: CROSSING_END_TEXT,
			supersedes: mirror?.id,
		});
		expect(JSON.stringify(end)).not.toContain("lrgp11ms");
	});

	it("ends there when the person ends it through another peer, and not on another's say", () => {
		const hold = sent({
			from: "16V6F4",
			to: [ALL],
			intent: "hold",
			text: SECRET,
			pid: 7,
		});
		sent({
			from: "P9R1KI",
			to: [ALL],
			intent: "fyi",
			text: "go",
			pid: 8,
			re: hold.id,
		});
		expect(personalMessages()).toHaveLength(1);

		sent({
			from: "P9R1KI",
			to: [ALL],
			intent: "fyi",
			text: "Joel says it's over",
			pid: 8,
			re: hold.id,
			endsHold: true,
		});
		expect(personalMessages().map((one) => one.text)).toEqual([
			CROSSING_HOLD_TEXT,
			CROSSING_END_TEXT,
		]);
	});

	it("crosses nothing that isn't a machine hold", () => {
		sent({
			from: "85PKB2",
			to: ["#quest/wcjqsg"],
			intent: "hold",
			text: SECRET,
			pid: 9,
		});
		sent({
			from: "85PKB2",
			to: ["4UHC5Q"],
			intent: "question",
			text: SECRET,
			pid: 9,
		});
		expect(personalMessages()).toEqual([]);
	});

	it("crosses nothing on a machine in one realm", () => {
		crossings = { ...crossings, others: () => [] };
		sent({ from: "16V6F4", to: [ALL], intent: "hold", text: SECRET, pid: 7 });
		expect(personalMessages()).toEqual([]);
	});
});
