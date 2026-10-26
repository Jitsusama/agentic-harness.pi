# Tests of lib/core

The tests of `../../lib/core/`, a folder for each of its folders, by the
same name. Two folders don't mirror one:

| Folder     | Holds                                                           |
| ---------- | --------------------------------------------------------------- |
| `browser/` | the browser lane, which drives a real Chrome                    |
| `package/` | rules every library in `lib/core` keeps, read across its files |
| `support/` | helpers several of these folders' tests share                   |
