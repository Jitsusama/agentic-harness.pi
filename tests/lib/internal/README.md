# Internal Library Tests

The tests of `lib/internal`, the library nothing outside the package
imports: a test file beside the name of the module it tests, and a
folder for each of its folders. The tests in `fence/` that name no
module of their own, such as `fence-agent`, test the fence
(`fence/fence.ts`) one boundary at a time; `fence-sockets` runs in
the process lane, which `vitest.config.ts` names it in by path.
