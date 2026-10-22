/**
 * What a mail does to the session it reaches: into the conversation,
 * on screen only, or a turn.
 */
import { describe, expect, it } from "vitest";
import type { Mail } from "../../../lib/mail/mailbox.ts";
import {
	concernFrom,
	mentions,
	type Standing,
	triage,
} from "../../../lib/mail/triage.ts";

function mail(over: Partial<Mail> = {}): Mail {
	return {
		at: "2026-10-22T02:22:00.000Z",
		from: "2HN63P",
		to: ["ALL"],
		text: "merging core.nix#330 now (modules/guide only)",
		kind: "fyi",
		pid: 1,
		...over,
	};
}

const standing: Standing = {
	names: ["5GV2AH", "24B025FE"],
	receiver: {
		name: "5GV2AH",
		worksOn: "Protections That Lead to Good Outcomes",
		owns: ["agentic-harness.pi", "harness", "QEST-20261021-5GV2AH"],
	},
	idle: false,
};

describe("triage", () => {
	it("keeps another session's own business out of the conversation", () => {
		const verdict = triage(mail(), { ...standing, concern: "other" });
		expect(verdict).toMatchObject({ into: "screen", wake: false });
	});

	it("keeps a hold in whatever it is judged, since missing one costs someone", () => {
		const hold = mail({ kind: "hold", text: "hold heavy builds 4 min" });
		expect(triage(hold, { ...standing, concern: "other" }).into).toBe(
			"context",
		);
	});

	it("delivers what it cannot judge, as mail always was", () => {
		expect(triage(mail(), standing)).toMatchObject({
			into: "context",
			wake: false,
			why: "not judged, so delivered",
		});
	});

	it("delivers mail addressed by name whatever it is judged", () => {
		const named = mail({ to: ["5GV2AH"] });
		expect(triage(named, { ...standing, concern: "other" }).into).toBe(
			"context",
		);
	});

	it("wakes an idle session for a question it is the one to answer", () => {
		const asked = mail({ kind: "question", to: ["5GV2AH"], text: "why?" });
		expect(triage(asked, { ...standing, idle: true }).wake).toBe(true);
		expect(triage(asked, standing).wake).toBe(false);
		const broadcast = mail({ kind: "question", text: "who has a build up?" });
		expect(triage(broadcast, { ...standing, idle: true }).wake).toBe(false);
		expect(
			triage(broadcast, { ...standing, idle: true, concern: "receiver" }).wake,
		).toBe(true);
	});

	it("never wakes for anything but a question", () => {
		const finding = mail({ kind: "finding", to: ["5GV2AH"] });
		expect(triage(finding, { ...standing, idle: true }).wake).toBe(false);
	});

	it("reads a mention of the session or what it owns as concerning it", () => {
		// Without a classifier, so a question about the harness still wakes.
		const asked = mail({
			kind: "question",
			text: "is that refusal from the Harness?",
		});
		expect(mentions(asked, standing)).toBe(true);
		expect(triage(asked, { ...standing, idle: true }).wake).toBe(true);
		expect(mentions(mail({ text: "a 5gv2ah-ish word" }), standing)).toBe(true);
		expect(mentions(mail(), standing)).toBe(false);
	});
});

describe("concernFrom", () => {
	it("trusts a sure 'not yours' and nothing less", () => {
		const other = (p: number) => ({
			type: "choice",
			choice: "other",
			probabilities: { other: p, receiver: 1 - p, machine: 0 },
		});
		expect(concernFrom(other(0.93))).toBe("other");
		expect(concernFrom(other(0.55))).toBeUndefined();
		expect(concernFrom({ type: "choice", choice: "receiver" })).toBe(
			"receiver",
		);
		expect(concernFrom({ type: "choice", choice: "nonsense" })).toBeUndefined();
		expect(concernFrom(undefined)).toBeUndefined();
	});
});
