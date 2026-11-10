import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "notebook-test-home-"));
try {
  const config = join(home, ".gitconfig");
  await writeFile(config, "");
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Notebook Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Notebook Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  for (const key of ["NOTEBOOK_DIR", "NOTEBOOK_PORT", "NOTEBOOK_DEBUG"])
    delete env[key as keyof typeof env];
  const requested = process.argv.slice(2);
  const tests = requested.some((arg) => arg.endsWith(".test.ts"))
    ? []
    : (await readdir("test"))
        .filter((name) => name.endsWith(".test.ts"))
        .sort()
        .map((name) => join("test", name));
  process.exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--test", "--test-concurrency=4", ...requested, ...tests],
      { env, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
} finally {
  await rm(home, { recursive: true, force: true });
}
