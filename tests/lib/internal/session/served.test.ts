import { describe, expect, it } from "vitest";
import {
	sameServer,
	saysWho,
	servedBy,
	servedFrom,
} from "../../../../lib/internal/session/served.ts";

/** The headers one response through Shopify's proxy carried on 9 November. */
const PROXIED = {
	"x-shopify-proxy-provider": "anthropic-dev",
	"anthropic-organization-id": "d7eadd60-ad57-4596-8568-d316d773eb14",
	"anthropic-workspace-id": "wrkspc_01Ha2NTyMsTP2YW2gPt76FY8",
	"cf-ray": "a579bec959c9e826-ORD",
	"content-type": "text/event-stream",
};

describe("who served a response", () => {
	it("is the proxy's backend, the Anthropic account and the edge", () => {
		expect(servedBy(PROXIED)).toEqual({
			backend: "anthropic-dev",
			account:
				"d7eadd60-ad57-4596-8568-d316d773eb14/wrkspc_01Ha2NTyMsTP2YW2gPt76FY8",
			edge: "ORD",
		});
	});

	it("is only what a response said, and nothing for one that said none", () => {
		const direct = servedBy({ "anthropic-organization-id": "org-a" });

		expect({
			direct,
			none: servedBy({ "content-type": "text/plain" }),
		}).toEqual({
			direct: { account: "org-a" },
			none: {},
		});
		expect(saysWho(direct), "an account alone says who").toBe(true);
		expect(saysWho({}), "an empty answer says nobody").toBe(false);
	});

	it("is the same server only when every part it names is", () => {
		const one = servedBy(PROXIED);

		expect({
			same: sameServer(servedFrom(JSON.parse(JSON.stringify(one))), one),
			otherEdge: sameServer({ ...one, edge: "IAD" }, one),
			unknown: sameServer(undefined, one),
		}).toEqual({ same: true, otherEdge: false, unknown: false });
	});
});
