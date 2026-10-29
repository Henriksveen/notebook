import { parseInvocation } from "./args.ts";
import { HANDLERS } from "./commands.ts";
import { resolvePort } from "./config.ts";
import { NotebookError } from "./errors.ts";
import {
  failureJson,
  failureText,
  successJson,
  toFailure,
  USAGE_TEXT,
} from "./output.ts";
import { resolveDataDir } from "./paths.ts";

export async function main(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  try {
    const invocation = parseInvocation(argv);
    if (invocation.kind === "help") {
      if (json) {
        process.stdout.write(
          successJson({ data: { usage: USAGE_TEXT }, warnings: [], text: "" }),
        );
      } else {
        process.stdout.write(USAGE_TEXT);
      }
      return 0;
    }
    const { command, positionals, values } = invocation;
    const outcome = await HANDLERS[command]({
      dir: resolveDataDir({ flag: values.dir }),
      port: resolvePort({ flag: values.port }),
      positionals,
      values,
    });
    if (json) {
      process.stdout.write(successJson(outcome));
    } else {
      process.stdout.write(`${outcome.text}\n`);
      for (const warning of outcome.warnings) {
        process.stderr.write(`warning: ${warning}\n`);
      }
    }
    return 0;
  } catch (error) {
    const failure = toFailure(error);
    if (json) {
      process.stdout.write(failureJson(failure));
    } else {
      process.stderr.write(failureText(failure));
    }
    if (
      process.env.NOTEBOOK_DEBUG === "1" &&
      !(error instanceof NotebookError)
    ) {
      process.stderr.write(
        `${String(error instanceof Error ? error.stack : error)}\n`,
      );
    }
    return failure.exitCode;
  }
}

process.exitCode = await main(process.argv.slice(2));
