# Panel

What every panel shares, whichever prompt draws it: how tall it may
be (`panel-height.ts`), the chrome and footer its prompts lay out
(`panel-layout.ts`), the room and the screen it is told about while
it is drawn (`panel-room.ts`, `panel-screen.ts`), and the registry
that closes every panel up or waiting when a session ends
(`panel-registry.ts`).

The panels themselves, and what callers mount them through, are
`../panel.ts` and `../mount.ts`.
