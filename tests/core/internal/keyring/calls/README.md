# Keyring Call Stand-Ins

Programs that take the place of `lib/core/internal/keyring/secret-service-call.mjs`
in `secret-service-call.test.ts`, each answering one call the way the real one
might: remembering values in a file, crashing, refusing, complaining on stderr,
leaving node's own several-line report, answering nothing readable, lingering
after its answer, or holding until the test lets it go. Each says in its first line what it does.
