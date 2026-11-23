// check-there.sh's turns on a host with util-linux's flock, in a file of
// their own so they run beside the Mac's.

import { describeTurns } from "./support/check-there.ts";

describeTurns("with util-linux's flock");
