import {
  invalid,
  JSON_LIMIT,
  object,
  type PromptInput,
} from "./library-schema.ts";
export function renderPrompt(
  prompt: Pick<PromptInput, "template" | "inputs">,
  value: unknown,
): string {
  const values = object(value);
  if (Buffer.byteLength(JSON.stringify(values)) > JSON_LIMIT)
    invalid("render values exceed 4 MiB");
  if (
    Object.keys(values).some(
      (name) => !prompt.inputs.some((input) => input.name === name),
    )
  )
    invalid("unknown prompt input");
  const resolved = new Map<string, string>();
  for (const input of prompt.inputs) {
    const raw = Object.hasOwn(values, input.name)
      ? values[input.name]
      : input.default;
    if (typeof raw !== "string" || (raw === "" && input.default === undefined))
      invalid(`missing or invalid input: ${input.name}`);
    resolved.set(input.name, raw);
  }
  let length = Buffer.byteLength(prompt.template);
  for (const match of prompt.template.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)) {
    length +=
      Buffer.byteLength(resolved.get(match[1]) ?? "") -
      Buffer.byteLength(match[0]);
    if (length > JSON_LIMIT) invalid("rendered prompt exceeds 4 MiB");
  }
  return prompt.template.replace(
    /\{\{([a-z][a-z0-9_]*)\}\}/g,
    (_, name: string) => resolved.get(name) ?? "",
  );
}
