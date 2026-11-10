import { publish } from "../../src/library-transaction.ts";
import { withWriteLock } from "../../src/lock.ts";

const [dir, step, first, second] = process.argv.slice(2);
await withWriteLock(dir, () =>
  publish(dir, { [first]: "new html", [second]: null }, "crash test", {
    boundary: (boundary) => {
      if (boundary === step) process.kill(process.pid, "SIGKILL");
    },
  }),
);
