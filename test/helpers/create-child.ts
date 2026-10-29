import { createEntry } from "../../src/notebook.ts";

const [dir, title] = process.argv.slice(2);

const result = await createEntry(dir, {
  title,
  summary: "Created by a concurrent process.",
  type: "note",
  body: `Body for ${title}.\n`,
});
process.stdout.write(JSON.stringify(result));
