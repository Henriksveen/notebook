import assert from "node:assert/strict";
import { symlink, unlink } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import {
  type AddressInfo,
  createServer as createNetServer,
  type Socket,
} from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createItem, itemUrl, updateItem } from "../src/library.ts";
import { readItem } from "../src/library-store.ts";
import { openNotebook } from "../src/web/open.ts";
import {
  REPORT_CSP,
  REPORT_VIEWER_CSP,
  SECURITY_HEADERS,
} from "../src/web/security.ts";
import { createServer, type WebServer } from "../src/web/server.ts";
import {
  cleanupTempDirs,
  freePort,
  git,
  ID_1,
  makeTempDir,
  newNotebook,
} from "./fixtures.ts";

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}
function request(
  port: number,
  path: string,
  options: { method?: string; host?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { Host: options.host ?? `127.0.0.1:${port}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
after(cleanupTempDirs);

describe("page/prompt website", () => {
  let server: WebServer,
    dir: string,
    page: Awaited<ReturnType<typeof createItem>>,
    prompt: Awaited<ReturnType<typeof createItem>>;
  before(async () => {
    dir = await newNotebook();
    page = await createItem(
      dir,
      "page",
      {
        title: "Guide <script>alert(1)</script>",
        summary: "Description <b>text</b>",
        kind: "concept",
        context: "PRIVATE-CONTEXT-SENTINEL",
      },
      "<h1>REPORT-SENTINEL</h1><script>window.inlineRan=true</script>",
    );
    prompt = await createItem(dir, "prompt", {
      title: "Template",
      description: "Reusable",
      template: "Explain {{x}} </textarea><img src=x>",
      inputs: [{ name: "x", description: "Subject" }],
    });
    server = await createServer({ dir, port: 0 });
  });
  after(async () => {
    await server.close();
  });
  it("keeps security headers on successful, missing and rejected responses", async () => {
    const [home, ...others] = await Promise.all([
      request(server.port, "/"),
      request(server.port, "/static/style.css"),
      request(server.port, "/_health"),
      request(server.port, "/missing"),
      request(server.port, "/", { host: "evil.example" }),
      request(server.port, "/", { method: "POST" }),
    ]);
    for (const reply of others)
      for (const [name, value] of Object.entries(SECURITY_HEADERS))
        assert.equal(reply.headers[name.toLowerCase()], value);
    // The library list runs its own same-origin filter script, nothing inline.
    for (const [name, value] of Object.entries(SECURITY_HEADERS))
      if (name !== "Content-Security-Policy")
        assert.equal(home.headers[name.toLowerCase()], value);
    assert.equal(
      home.headers["content-security-policy"],
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    assert.equal(
      (await request(server.port, "/", { host: "evil.example" })).status,
      421,
    );
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const reply = await request(server.port, `/pages/${page.id}`, { method });
      assert.equal(reply.status, 405);
      assert.equal(reply.headers.allow, "GET, HEAD");
    }
  });
  it("answers HEAD with no body and rejects path traversal", async () => {
    for (const path of [
      "/",
      `/pages/${page.id}`,
      `/pages/${page.id}/versions/${page.commit}/content`,
    ]) {
      const reply = await request(server.port, path, { method: "HEAD" });
      assert.equal(reply.status, 200);
      assert.equal(reply.body, "");
      assert.ok(Number(reply.headers["content-length"]) > 0);
    }
    for (const path of [
      "/pages/../.git/config",
      "/.notebook-format",
      "/pages/%2e%2e%2fetc",
      "/static/../README.md",
      `/pages/${page.id}/versions/HEAD/content`,
    ])
      assert.equal((await request(server.port, path)).status, 404, path);
  });
  it("escapes card metadata and exposes no supporting context", async () => {
    const home = await request(server.port, "/");
    assert.match(home.body, /Guide &lt;script&gt;alert/);
    assert.match(home.body, /Description &lt;b&gt;text&lt;\/b&gt;/);
    assert.doesNotMatch(home.body, /<script>alert|PRIVATE-CONTEXT-SENTINEL/);
    const view = await request(server.port, `/pages/${page.id}`);
    assert.doesNotMatch(view.body, /PRIVATE-CONTEXT-SENTINEL|<script>alert/);
    assert.equal(view.headers["content-security-policy"], REPORT_VIEWER_CSP);
    assert.match(view.body, /sandbox="allow-scripts"/);
    assert.doesNotMatch(view.body, /allow-same-origin/);
  });
  it("uses identical isolation for current and historical HTML and downloads safely", async () => {
    const before = await readItem(dir, "page", page.id);
    const updated = await updateItem(
      dir,
      "page",
      page.id,
      before.revision,
      { change_summary: "New explanation" },
      "<h1>UPDATED-SENTINEL</h1>",
    );
    const wrapper = await request(server.port, `/pages/${page.id}`);
    assert.ok(wrapper.body.includes(updated.commit));
    const old = await request(
        server.port,
        `/pages/${page.id}/versions/${page.commit}/content`,
      ),
      current = await request(
        server.port,
        `/pages/${page.id}/versions/${updated.commit}/content`,
      );
    assert.match(old.body, /REPORT-SENTINEL/);
    assert.doesNotMatch(old.body, /UPDATED-SENTINEL/);
    assert.match(current.body, /UPDATED-SENTINEL/);
    for (const reply of [old, current]) {
      assert.equal(reply.headers["content-security-policy"], REPORT_CSP);
      assert.equal(reply.headers["x-frame-options"], "SAMEORIGIN");
      assert.equal(reply.headers["content-type"], "text/html; charset=utf-8");
    }
    const downloaded = await request(
      server.port,
      `/pages/${page.id}/versions/${updated.commit}/download`,
    );
    assert.equal(
      downloaded.headers["content-type"],
      "application/octet-stream",
    );
    assert.match(
      String(downloaded.headers["content-disposition"]),
      /^attachment;/,
    );
    assert.equal(downloaded.body, "<h1>UPDATED-SENTINEL</h1>");
    assert.equal(
      (await request(server.port, `/pages/${page.id}/history`)).status,
      200,
    );
  });
  it("confines trusted JavaScript to prompt preview and escapes template markup", async () => {
    const reply = await request(server.port, `/prompts/${prompt.id}`);
    assert.equal(reply.status, 200);
    assert.match(
      String(reply.headers["content-security-policy"]),
      /script-src 'self'/,
    );
    assert.doesNotMatch(
      String(reply.headers["content-security-policy"]),
      /unsafe-inline/,
    );
    assert.match(reply.body, /&lt;\/textarea&gt;&lt;img src=x&gt;/);
    assert.doesNotMatch(reply.body, /<img src=x>/);
    assert.match(reply.body, /<script src="\/static\/prompt.js" defer>/);
    assert.equal(
      (await request(server.port, "/static/prompt.js")).headers["content-type"],
      "text/javascript; charset=utf-8",
    );
    assert.equal(
      (
        await request(
          server.port,
          `/prompts/${prompt.id}/versions/${prompt.commit}/content`,
        )
      ).status,
      404,
    );
  });
  it("lists pages compactly with project and kind but no tags or filter form", async () => {
    await createItem(
      dir,
      "page",
      {
        title: "Tagged page",
        summary: "Has topics",
        kind: "report",
        project: "repo-one",
        topics: ["legacy-topic"],
      },
      "<p>Body</p>",
    );
    const reply = await request(server.port, "/pages?q=repo");
    assert.equal(reply.status, 200);
    assert.match(
      String(reply.headers["content-security-policy"]),
      /script-src 'self'/,
    );
    assert.match(reply.body, /<script src="\/static\/list.js" defer>/);
    assert.match(reply.body, /data-filter-value="repo-one"/);
    assert.match(reply.body, /class="kind kind-report">report</);
    assert.match(reply.body, /id="list-filter"[^>]*value="repo"/);
    assert.doesNotMatch(
      reply.body,
      /legacy-topic|include_archived|Find<\/button>|<form|Archived/,
    );
    assert.equal(
      (await request(server.port, "/static/list.js")).headers["content-type"],
      "text/javascript; charset=utf-8",
    );
  });
  it("lists prompts as copyable blocks without filter forms or tags", async () => {
    await createItem(dir, "prompt", {
      title: "Second prompt",
      description: "Other",
      topics: ["legacy-topic"],
      template: "Other text",
      inputs: [],
    });
    const reply = await request(server.port, "/prompts?q=explain");
    assert.equal(reply.status, 200);
    assert.match(
      String(reply.headers["content-security-policy"]),
      /script-src 'self'/,
    );
    assert.match(reply.body, /<script src="\/static\/prompt.js" defer>/);
    assert.match(reply.body, /data-prompt/);
    assert.match(reply.body, /class="copy"/);
    assert.match(reply.body, /id="list-filter"[^>]*value="explain"/);
    assert.match(reply.body, /<span class="hole">\{\{x\}\}<\/span>/);
    assert.match(reply.body, /&lt;\/textarea&gt;&lt;img src=x&gt;/);
    assert.doesNotMatch(
      reply.body,
      /<img src=x>|include_archived|Find<\/button>|legacy-topic|<form/,
    );
  });
  it("does not follow a committed symlink as page content", async () => {
    const bad = await createItem(
      dir,
      "page",
      { title: "Symlink fixture", summary: "Invalid content", kind: "report" },
      "Safe",
    );
    const file = join(dir, `pages/${bad.id}/index.html`);
    await unlink(file);
    await symlink("/etc/passwd", file);
    await git(dir, ["add", "pages"]);
    await git(dir, ["commit", "-m", "bad content fixture"]);
    assert.equal((await request(server.port, `/pages/${bad.id}`)).status, 404);
  });
});
describe("open", () => {
  const spawned: number[] = [];
  let savedHome: string | undefined;

  before(async () => {
    savedHome = process.env.HOME;
    process.env.HOME = await makeTempDir();
  });

  after(async () => {
    for (const pid of spawned.splice(0)) await stopProcess(pid);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("starts a server, then reuses it", async () => {
    const dir = await newNotebook();
    const port = await freePort();
    const first = await openNotebook({ dir, port, noBrowser: true });
    assert.ok(first.pid);
    spawned.push(first.pid);
    assert.equal(first.reused, false);
    assert.equal(first.url, `http://127.0.0.1:${port}/`);
    assert.deepEqual(first.warnings, []);
    assert.equal((await request(port, "/_health")).status, 200);

    const second = await openNotebook({
      dir,
      port,
      noBrowser: true,
      itemPath: `/pages/${ID_1}`,
    });
    assert.equal(second.reused, true);
    assert.equal(second.pid, undefined);
    assert.equal(second.url, itemUrl("page", ID_1, port));
  });

  it("refuses a port held by another notebook", async () => {
    const other = await newNotebook();
    const port = await freePort();
    const running = await createServer({ dir: await makeTempDir(), port });
    try {
      await assert.rejects(
        openNotebook({ dir: other, port, noBrowser: true }),
        {
          code: "PORT_IN_USE",
        },
      );
    } finally {
      await running.close();
    }
  });

  it("refuses a port held by a foreign listener", async () => {
    const sockets = new Set<Socket>();
    const foreign = createNetServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      foreign.listen(0, "127.0.0.1", resolve),
    );
    const { port } = foreign.address() as AddressInfo;
    try {
      await assert.rejects(
        openNotebook({ dir: await newNotebook(), port, noBrowser: true }),
        { code: "PORT_IN_USE" },
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
    }
  });

  it("does not wait on a listener that trickles bytes forever", {
    timeout: 15_000,
  }, async () => {
    const sockets = new Set<Socket>();
    const trickle = createNetServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => {
        sockets.delete(socket);
        clearInterval(timer);
      });
      socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n");
      const timer = setInterval(() => socket.write(" "), 100);
    });
    await new Promise<void>((resolve) =>
      trickle.listen(0, "127.0.0.1", resolve),
    );
    const { port } = trickle.address() as AddressInfo;
    try {
      const started = Date.now();
      await assert.rejects(
        openNotebook({ dir: await newNotebook(), port, noBrowser: true }),
        { code: "PORT_IN_USE" },
      );
      assert.ok(Date.now() - started < 2500, "probe must give up quickly");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => trickle.close(() => resolve()));
    }
  });

  it("reports opener failures as warnings, and passes the URL to the opener", async () => {
    const dir = await newNotebook();
    const port = await freePort();
    const first = await openNotebook({ dir, port, noBrowser: true });
    spawned.push(first.pid ?? 0);
    const opened: string[] = [];
    const ok = await openNotebook({
      dir,
      port,
      itemPath: `/pages/${ID_1}`,
      opener: async (url) => {
        opened.push(url);
      },
    });
    assert.deepEqual(opened, [itemUrl("page", ID_1, port)]);
    assert.deepEqual(ok.warnings, []);
    const failed = await openNotebook({
      dir,
      port,
      opener: async () => {
        throw new Error("no browser");
      },
    });
    assert.equal(failed.reused, true);
    assert.equal(failed.warnings.length, 1);
    assert.equal(
      failed.warnings[0]?.includes(`http://127.0.0.1:${port}/`),
      true,
    );
  });
});

async function stopProcess(pid: number): Promise<void> {
  if (pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
