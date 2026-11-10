/**
 * The sandbox's cloud tokens come from the broker in the background, at
 * most once every few minutes, and a machine whose broker gives none hands
 * commands none, saying why.
 */

import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
	ASK_EVERY_MS,
	type CloudAsk,
	cloudGrants,
	namesTheCloud,
	USED_FOR_MS,
} from "../../../lib/internal/gcloud-broker.ts";

const TOKEN = `ya29.${"a0B1-c2_D3".repeat(20)}`;
const PROJECT = "a-lab-project";

/** A broker answering each verb with `answers` in turn, counting how often it's asked. */
function broker(answers: {
	access: Array<string | Error>;
	project?: string | Error;
}) {
	const asked = { access: 0, project: 0 };
	const ask: CloudAsk = (verb) => {
		const answer =
			verb === "project"
				? (answers.project ?? `${PROJECT}\n`)
				: answers.access[Math.min(asked.access, answers.access.length - 1)];
		asked[verb] += 1;
		if (answer instanceof Error) return Promise.reject(answer);
		return Promise.resolve(answer ?? "");
	};
	return { ask, asked };
}

/** Lets every answer already given settle. */
async function settled(): Promise<void> {
	await setImmediate();
}

describe("the cloud broker's grants", () => {
	it("are asked for at the first command, which is told the first is on its way", async () => {
		const { ask, asked } = broker({ access: [`${TOKEN}\n`] });
		const grants = cloudGrants(ask, () => 0);
		expect(grants()).toEqual({
			reason: expect.stringContaining(
				"still minting this session's first token",
			),
		});
		await settled();
		expect(grants()).toEqual({ token: TOKEN, project: PROJECT });
		expect(asked).toEqual({ access: 1, project: 1 });
	});

	it("are asked for once while fresh, however many commands ask", async () => {
		const { ask, asked } = broker({ access: [TOKEN] });
		let now = 0;
		const grants = cloudGrants(ask, () => now);
		grants();
		await settled();
		now = ASK_EVERY_MS - 1;
		grants();
		grants();
		await settled();
		expect(asked.access).toBe(1);
	});

	it("keep handing the last token while the next is minted, until it would be spent", async () => {
		const fresh = `ya29.${"Z".repeat(40)}`;
		let answer: (token: string) => void = () => undefined;
		let first = true;
		const ask: CloudAsk = (verb) => {
			if (verb === "project") return Promise.resolve(PROJECT);
			if (first) {
				first = false;
				return Promise.resolve(TOKEN);
			}
			return new Promise((resolve) => {
				answer = resolve;
			});
		};
		let now = 0;
		const grants = cloudGrants(ask, () => now);
		grants();
		await settled();
		now = ASK_EVERY_MS;
		expect(grants()).toEqual({ token: TOKEN, project: PROJECT });
		// The project is answered, and the token asked for, but not given.
		await settled();
		now = USED_FOR_MS;
		expect(grants()).toEqual({
			reason: expect.stringContaining("still minting a fresh token"),
		});
		answer(fresh);
		await settled();
		expect(grants()).toEqual({ token: fresh, project: PROJECT });
	});

	it("are none where the machine has no broker, saying so, and it isn't asked again at once", async () => {
		const missing = Object.assign(new Error("spawn gcloud-broker ENOENT"), {
			code: "ENOENT",
		});
		const { ask, asked } = broker({ access: [TOKEN], project: missing });
		const grants = cloudGrants(ask, () => 0);
		grants();
		await settled();
		expect(grants()).toEqual({
			reason: expect.stringContaining("gcloud-broker isn't on this machine"),
		});
		grants();
		await settled();
		expect(asked.project).toBe(1);
	});

	it("are none when gcloud refused, with the last thing the broker said", async () => {
		const failed = Object.assign(
			new Error("Command failed: gcloud-broker access"),
			{
				code: 1,
				said: "a note\ngcloud refused a token: Reauthentication required.\n",
			},
		);
		const { ask } = broker({ access: [failed] });
		const grants = cloudGrants(ask, () => 0);
		grants();
		await settled();
		expect(grants()).toEqual({
			reason: "gcloud refused a token: Reauthentication required.",
		});
	});

	it("are none when the broker answers with something other than a token or a project", async () => {
		for (const [access, project] of [
			["", PROJECT],
			["ya29.short", PROJECT],
			[`${TOKEN} extra`, PROJECT],
			["ya29.$(rm -rf ~)xxxxxxxxxxxxxxxxxx", PROJECT],
			[`ya29.${"x".repeat(4100)}`, PROJECT],
			[TOKEN, "Not A Project"],
			[TOKEN, "a'b"],
		] as const) {
			const grants = cloudGrants(
				broker({ access: [access], project }).ask,
				() => 0,
			);
			grants();
			await settled();
			const grant = grants();
			expect(grant).toHaveProperty("reason");
			expect(JSON.stringify(grant)).not.toContain(access || "never");
		}
	});
});

describe("a command that names the cloud", () => {
	it("is one running gcloud, gsutil or bq, however it's written", () => {
		for (const command of [
			"gcloud compute instances list",
			"cd x && gsutil ls gs://b",
			"FOO=1 bq query 'select 1'",
			"(gcloud auth list)",
			"/nix/store/abc-google-cloud-sdk/bin/gcloud info",
		]) {
			expect(namesTheCloud(command), command).toBe(true);
		}
	});

	it("isn't one that only names something like them", () => {
		for (const command of [
			"ls",
			"cat gcloud.md",
			"echo my-gcloud-thing",
			"bqx",
		]) {
			expect(namesTheCloud(command), command).toBe(false);
		}
	});
});
