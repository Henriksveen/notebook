import { appendFile } from "node:fs/promises";
import { withWriteLock } from "../../src/lock.ts";

const [dir, log, holdMs] = process.argv.slice(2);

await withWriteLock(dir, async () => {
  await appendFile(log, `start ${process.pid}\n`);
  await new Promise((done) => setTimeout(done, Number(holdMs)));
  await appendFile(log, `end ${process.pid}\n`);
});
