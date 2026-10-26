/**
 * The signature store contract a gate reads and writes. The
 * loop breaker in decision.ts needs to know which violation
 * signatures it has already blocked this session; this is the
 * interface that supplies them, kept pure so the decision logic
 * stays free of any session or runtime dependency. The
 * session-backed implementation lives in lib/internal/gate.
 */
export interface GateDeps {
	/** Every block signature recorded this session. */
	readSignatures: () => string[];
	/** Record a new block signature. */
	persistSignature: (signature: string) => void;
}
