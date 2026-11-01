# Development rules

- **Never use the real notebook for development.** Do not read or modify the user's notebook,
  run the installer against their home directory, or start their notebook server unless asked.
  Tests must use temporary directories, isolated HOME/Git configuration, local bare remotes,
  and free localhost ports. Never change global Git configuration.
- **Keep the architecture small.** Plain files and Git are intentional. Ask before introducing
  a database, framework, build step, or new runtime dependency.
- **Privacy is a product requirement.** Never add automatic content capture, telemetry, or
  external report dependencies. Do not weaken secret scanning or report isolation to make a
  feature work; discuss the trade-off first.
- **Keep agent context lean.** Put specialized workflow and design instructions in
  `skills/notebook/references/`, linked from `SKILL.md` and loaded only when relevant.
- **Document behavior, not implementation twice.** Update `README.md` for user-visible changes;
  keep skill-specific instructions in the skill. Do not expand this file with code maps,
  command lists, or rules already expressed in code and tests.
- **Verify browser security in a browser.** Header assertions alone do not demonstrate sandbox
  enforcement. When changing report CSP or framing, smoke-test script execution, origin
  isolation, and blocked requests; state explicitly if a browser check was unavailable.
