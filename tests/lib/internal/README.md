# Internal Library Tests

The tests of `lib/internal`, the library nothing outside the package
imports: a test file beside the name of the module it tests, and a
folder for each of its folders. The tests in `fence/` that name no
module of their own, such as `fence-agent`, test the fence
(`fence/fence.ts`) one boundary at a time; `fence-sockets` does too,
and stays here while `vitest.config.ts`, which the host gate covers,
names it by path in its process lane.

Many entries because they mirror `lib/internal`, which is past 40
itself and waits in `tests/package/code/long-files-waiting.txt`: every
loose test answers a loose module there, and every folder one of its
folders, so moving the tests into folders of their own would leave
them mirroring nothing until the library is split.
