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
		]) {
			const read = needFrom(word);
			expect(read.ok && needWords(read.need), word).toBe(word);
		}
		const reach = needFrom("reach=shopify-services");
		expect(reach.ok && needOnTheWire(reach.need)).toEqual({
			reach: "shopify-services",
		});
	});

	it("refuses words that aren't a need, naming the kinds it takes", () => {
		for (const word of ["home", "colour=blue", "reach=", "accelerator=tpu"]) {
			const read = needFrom(word);
			expect(read.ok, word).toBe(false);
		}
		const read = needFrom("colour=blue");
		expect(!read.ok && read.reason).toBe(
			'"colour=blue" is not a need: kind=value, the kind one of machine, system, arch, reach, accelerator',
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
		expect(placedFrom("not json").ok).toBe(false);
		expect(placedFrom(placement({ placed: {} })).ok).toBe(false);
	});
});
