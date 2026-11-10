import assert from "node:assert/strict";
import { after, it } from "node:test";
import { createItem } from "../src/library.ts";
import { createServer } from "../src/web/server.ts";
import { cleanupTempDirs, newNotebook } from "./fixtures.ts";

after(cleanupTempDirs);
it("opens HTML directly with a pinned isolated frame and hides context", async () => {
  const dir = await newNotebook();
  const item = await createItem(
    dir,
    "page",
    {
      title: "Rebasing",
      summary: "Learn Git",
      kind: "concept",
      context: "private support sentinel",
    },
    "<p>explanation sentinel</p><script>window.test=1</script>",
  );
  const server = await createServer({ dir, port: 0 });
  try {
    const home = await (await fetch(server.url)).text();
    assert.match(home, /Rebasing/);
    const view = await fetch(`${server.url}pages/${item.id}`);
    const html = await view.text();
    assert.match(html, /sandbox="allow-scripts"/);
    assert.doesNotMatch(html, /private support sentinel/);
    const frame = /src="([^"]+\/content)"/.exec(html)?.[1];
    assert.ok(frame?.includes(item.commit));
    const content = await fetch(new URL(frame ?? "", server.url));
    assert.match(
      content.headers.get("content-security-policy") ?? "",
      /connect-src 'none'/,
    );
    assert.match(await content.text(), /explanation sentinel/);
    const search = await (await fetch(`${server.url}?q=sentinel`)).text();
    assert.match(search, /Rebasing/);
    assert.equal(
      (await fetch(`${server.url}pages/${item.id}`, { method: "POST" })).status,
      405,
    );
  } finally {
    await server.close();
  }
});
