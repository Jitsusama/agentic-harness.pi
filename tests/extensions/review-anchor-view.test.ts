/**
 * Reading a remark against the code it points at.
 *
 * The publish gate used to show op counts and thread uuids, so approving
 * a review meant trusting that every anchor still pointed where it was
 * meant to. The diff is already in hand at that moment, fetched to judge
 * degradation, so showing the hunk costs nothing that was not already
 * paid for.
 *
 * When the diff cannot place the anchor, the view says so rather than
 * showing nothing: an empty panel reads as "no code here", which is a
 * different claim from "this anchor has come loose".
 */

import {
	type Anchor,
	parseUnifiedDiff,
} from "@jitsusama/agentic-harness.core/review";
import { describe, expect, it } from "vitest";
import { anchorView } from "../../extensions/review-integration/render.js";
import { plainTheme } from "../lib/ui/fake-theme.js";

const diff = parseUnifiedDiff(`diff --git a/pkg/policy.go b/pkg/policy.go
index 83db48f..bf269f4 100644
--- a/pkg/policy.go
+++ b/pkg/policy.go
@@ -160,6 +160,7 @@ func Parse(raw []byte) (*Policy, error) {
 	var policy Policy
 	dec := json.NewDecoder(bytes.NewReader(raw))
-	if err := dec.Decode(&policy); err != nil {
+	if err := dec.Decode(&policy); err != nil {
+		return nil, fmt.Errorf("ratelimitpolicy: %w", err)
 	}
 	return &policy, nil
`);

/** An anchor on the new side of the file above. */
function at(line: number, path = "pkg/policy.go"): Anchor {
	return { subject: "line", path, line, blob: "new" };
}

/** The view as one plain string. */
function drawn(anchor: Anchor, model = diff): string {
	return anchorView(anchor, model, plainTheme(), 72).join("\n");
}

describe("showing the code a remark points at", () => {
	it("shows the line the remark names", () => {
		expect(drawn(at(162))).toContain("dec.Decode");
	});

	it("shows the lines around it, so it can be read in context", () => {
		const text = drawn(at(162));
		expect(text).toContain("var policy Policy");
		expect(text).toContain("return &policy, nil");
	});

	it("numbers the lines, since the anchor is a number", () => {
		expect(drawn(at(162))).toContain("162");
	});

	it("says so when the file is not in the diff at all", () => {
		const text = drawn(at(10, "pkg/nowhere.go"));
		expect(text.toLowerCase()).toContain("not in this diff");
	});

	it("says so when the line is outside every hunk", () => {
		const text = drawn(at(9000));
		expect(text.toLowerCase()).toContain("not in this diff");
	});

	it("says so rather than drawing nothing, which would read as empty code", () => {
		expect(drawn(at(9000)).trim()).not.toBe("");
	});

	it("has nothing to draw for a remark about the whole change", () => {
		expect(drawn({ subject: "change" } as Anchor)).toContain("whole change");
	});
});
