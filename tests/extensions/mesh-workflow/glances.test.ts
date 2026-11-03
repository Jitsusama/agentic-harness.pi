/**
 * What a session's own entries say its deliveries handed over, so damping
 * carries on across a reload as if none had happened.
 */
import { describe, expect, it } from "vitest";
import { NOTED } from "../../../extensions/mesh-workflow/delivery.ts";
import { saidIn } from "../../../extensions/mesh-workflow/glances.ts";
import { ALL } from "../../../lib/mesh/group.ts";
import type { Message } from "../../../lib/mesh/message.ts";

const asked: Message = {
	v: 1,
	id: "1-WCJQSG-7-aaaaaaaa",
	at: "2026-10-22T04:00:00.000Z",
	from: "WCJQSG",
	to: [ALL],
	intent: "question",
	text: "who has qemu?",
	pid: 7,
};

describe("what deliveries handed over", () => {
	it("is each message they handed, by id", () => {
		const said = saidIn([
			{
				type: "custom_message",
				customType: NOTED,
				details: { messages: [asked], glanced: [], at: 5, turn: true },
			},
		]);

		expect(said).toEqual([
			{ at: 5, from: "WCJQSG", text: "who has qemu?", id: asked.id },
		]);
	});
});
