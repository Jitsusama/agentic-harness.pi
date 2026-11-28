/**
 * Where a mycelium node places work: needs in its words, and its answer.
 */

import { describe, expect, it } from "vitest";
import {
	needFrom,
	needOnTheWire,
	needWords,
	placedFrom,
} from "../../../lib/mesh/placement.ts";

const placement = (said: object) => JSON.stringify({ Ok: { Placement: said } });

describe("a need in the node's words", () => {
	it("reads kind=value for each kind the node places by", () => {
		for (const word of [
			"machine=equilibrius",
			"system=macos",
			"arch=aarch64",
			"reach=home",
			"accelerator=npu",
			"tool=gcloud",
		]) {
			const read = needFrom(word);
			expect(read.ok && needWords(read.need), word).toBe(word);
		}
		const reach = needFrom("reach=shopify-services");
		expect(reach.ok && needOnTheWire(reach.need)).toEqual({
			reach: "shopify-services",
		});
		const tool = needFrom("tool=gcloud");
		expect(tool.ok && needOnTheWire(tool.need)).toEqual({ tool: "gcloud" });
	});

	// Mycelium's need for any machine a provider made is a word with no
	// value, which serde writes as the bare string "cloud".
	it("reads cloud alone as the need for any machine a provider made", () => {
		const cloud = needFrom("cloud");
		expect(cloud).toEqual({ ok: true, need: { kind: "cloud" } });
		expect(cloud.ok && needWords(cloud.need)).toBe("cloud");
		expect(cloud.ok && needOnTheWire(cloud.need)).toBe("cloud");
		for (const word of ["cloud=yes", "clouds", "tool="]) {
			expect(needFrom(word).ok, word).toBe(false);
		}
	});

	it("refuses words that aren't a need, naming the kinds it takes", () => {
		for (const word of ["home", "colour=blue", "reach=", "accelerator=tpu"]) {
			const read = needFrom(word);
			expect(read.ok, word).toBe(false);
		}
		const read = needFrom("colour=blue");
		expect(!read.ok && read.reason).toBe(
			'"colour=blue" is not a need: cloud, or kind=value, the kind one of machine, system, arch, reach, accelerator, tool',
		);
	});
});

describe("the node's placement read", () => {
	it("hears the machine it chose", () => {
		expect(
			placedFrom(
				placement({
					placed: {
						machine: "optimus",
						passed: [{ machine: "penelope", because: ["ranked"] }],
					},
				}),
			),
		).toEqual({ ok: true, machine: "optimus" });
	});

	it("says each machine's reasons when none takes it", () => {
		const refused = placedFrom(
			placement({
				refused: {
					misses: [
						{ machine: "optimus", because: [{ lacks: { reach: "home" } }] },
						{
							machine: "equilibrius",
							because: [
								{ unknown: { reach: "home" } },
								{
									refuses: {
										key: "fleets",
										effect: "never",
										why: "no fleets here",
									},
								},
							],
						},
					],
				},
			}),
		);
		expect(refused).toEqual({
			ok: false,
			reason:
				"no machine takes it: optimus lacks reach=home; equilibrius hasn't said whether it has reach=home and refuses it (no fleets here)",
		});
	});

	it("names a taint by its key, or by nothing it can read, where it says no why", () => {
		const refused = placedFrom(
			placement({
				refused: {
					misses: [
						{ machine: "a", because: [{ refuses: { key: "fleets" } }] },
						{ machine: "b", because: [{ rather_not: {} }] },
					],
				},
			}),
		);
		expect(!refused.ok && refused.reason).toBe(
			"no machine takes it: a refuses it (fleets); b would rather not (?)",
		);
	});

	it("says a machine isn't in the cloud, leaves first, lives too short or went quiet", () => {
		const refused = placedFrom(
			placement({
				refused: {
					misses: [
						{ machine: "optimus", because: [{ lacks: "cloud" }] },
						{
							machine: "vm",
							because: [{ leaves_first: "2026-11-26T19:06:03Z" }],
						},
						{ machine: "made", because: [{ lives_only: "PT1H" }] },
						{ machine: "mac", because: ["unheard"] },
						{ machine: "new", because: [{ unknown: "cloud" }] },
						{ machine: "person", because: [{ full: 6 }] },
					],
				},
			}),
		);
		expect(!refused.ok && refused.reason).toBe(
			"no machine takes it: optimus isn't a cloud machine; vm leaves at 2026-11-26T19:06:03Z, before the work ends; made would live only PT1H, ending before the work; mac hasn't said its room lately; new hasn't said whether it has a cloud machine; person holds the 6 sessions it holds at most",
		);
	});

	it("quotes a peer's own words in a miss as they show", () => {
		const refused = placedFrom(
			placement({
				refused: {
					misses: [
						{
							machine: "a\u001b]0;run this\u0007",
							because: [{ refuses: { why: "busy\nnow `rm`" } }],
						},
						{ machine: "\u001b[0m", because: [{ refuses: { key: "\u200b" } }] },
					],
				},
			}),
		);
		expect(!refused.ok && refused.reason).toBe(
			"no machine takes it: a refuses it (busy / now 'rm'); ? refuses it (?)",
		);
	});

	it("says when only a machine out of reach would do", () => {
		expect(
			placedFrom(
				placement({
					pending: {
						misses: [{ machine: "equilibrius", because: ["unreachable"] }],
					},
				}),
			),
		).toEqual({
			ok: false,
			reason:
				"only a machine out of reach would take it: equilibrius is out of reach",
		});
	});

	it("hears the node's error, and takes what it can't read as nowhere", () => {
		expect(placedFrom('{"Err":"not a request"}')).toEqual({
			ok: false,
			reason: "not a request",
		});
		expect(
			placedFrom(
				'{"Err":"not a request: unknown variant `cloud`, expected one of `machine`"}',
			),
		).toEqual({
			ok: false,
			reason:
				"not a request: unknown variant `cloud`, expected one of `machine` (the node is older than the needs cloud and tool=)",
		});
		expect(placedFrom("not json")).toMatchObject({ ok: false });
		expect(placedFrom(placement({ placed: {} }))).toMatchObject({ ok: false });
		expect(placedFrom("\u001b[0m")).toEqual({
			ok: false,
			reason:
				"the node answered what this harness can't read: nothing that shows",
		});
	});
});
