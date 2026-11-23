/**
 * What `tsc` reads in place of the model providers' own SDKs, `openai`,
 * `@anthropic-ai/sdk` and `@google/genai`: nothing.
 *
 * This package never names them. They reach the typecheck only through
 * pi-ai's declarations, which import them for its provider adapters:
 * the OpenAI client and its `tool_choice` and `service_tier` fields, a
 * pre-built Anthropic client, Gemini's content parts. On 22 November that
 * was 494 files and about 199,000 lines, one in six of everything `tsc`
 * read for this project, spent typing options nothing here passes.
 * Without them a cold typecheck's heap is about 70 MB smaller, and every
 * declaration this project would emit is the same.
 *
 * tsconfig.json's `paths` maps each SDK and every path under it here.
 * pi-ai's references to them then resolve to nothing, which
 * `skipLibCheck` lets stand inside its declarations, and the few fields
 * typed from them read as `any`. A type taken from one of them here
 * fails the typecheck instead. To type something from an SDK, depend on
 * it in package.json and drop its mapping, at the cost of its lines.
 * `provider-sdk-types-stay-out.test.ts` pins where pi-ai takes them,
 * so an upgrade that types something new from them is seen.
 *
 * This maps types only. pi-ai loads the real SDKs at run time.
 */
export {};
