/**
 * Flag specs for the gh commands this package understands, defined
 * once in the domain that owns them and imported wherever a
 * consumer needs to read a gh flag (attribution, the interceptor).
 * The generic command model ships no flag tables; callers pass
 * these in.
 */

import type { FlagSpec } from "../../command/index.js";

/**
 * The body flags of gh pr/issue create and edit: the inline body
 * (--body, -b) and the body file (--body-file, -F), in both their
 * long and short forms.
 */
export const GH_BODY_SPEC: FlagSpec = {
	flags: [
		{ name: "body", long: "body", short: "b", takesValue: true },
		{ name: "body-file", long: "body-file", short: "F", takesValue: true },
	],
};
