(() => {
  const PLACEHOLDER = /\{\{([a-z][a-z0-9_]*)\}\}/g;
  const LIMIT = 4 * 1024 * 1024;
  const size = (text) => new TextEncoder().encode(text).length;

  function setup(block) {
    const template = block.dataset.template ?? "";
    const inputs = [...block.querySelectorAll("[data-variable]")];
    const pre = block.querySelector(".prompt-text");
    const label = block.querySelector(".code-label");
    const status = block.querySelector(".code-status");
    const copy = block.querySelector(".copy");
    const toggle = block.querySelector("[data-toggle-inputs]");
    const panel = block.querySelector(".prompt-inputs");
    const more = block.querySelector(".prompt-more");
    const clamp = !block.closest(".prompt-single");
    let expanded = false;
    let timer;

    const missing = () =>
      inputs.filter((i) => !i.value && i.dataset.hasDefault === "false");
    const values = () =>
      new Map(inputs.map((i) => [i.dataset.variable, i.value]));

    function say(message, tone = "", ms = 0) {
      clearTimeout(timer);
      status.textContent = message;
      status.className = `code-status${tone ? ` ${tone}` : ""}`;
      if (!message) copy.classList.remove("done");
      if (ms) timer = setTimeout(() => say(""), ms);
    }

    function fit() {
      if (!clamp || !more || block.hidden) return;
      pre.classList.toggle("clamped", !expanded);
      const overflowing = pre.scrollHeight > pre.clientHeight + 2;
      if (!expanded && !overflowing) pre.classList.remove("clamped");
      more.hidden = !expanded && !overflowing;
      more.textContent = expanded ? "Show less" : "Show all";
      more.setAttribute("aria-expanded", String(expanded));
    }

    function draw() {
      const map = values();
      const parts = [];
      let last = 0;
      for (const match of template.matchAll(PLACEHOLDER)) {
        parts.push(template.slice(last, match.index));
        const value = map.get(match[1]);
        if (value) {
          const span = document.createElement("span");
          span.className = "filled";
          span.textContent = value;
          parts.push(span);
        } else if (!map.has(match[1]) || isRequired(match[1])) {
          const span = document.createElement("span");
          span.className = "hole";
          span.textContent = match[0];
          parts.push(span);
        }
        last = match.index + match[0].length;
      }
      parts.push(template.slice(last));
      pre.replaceChildren(...parts);
      if (inputs.length) {
        const names = missing().map((i) => i.dataset.variable);
        label.textContent = names.length
          ? `needs ${names.join(", ")}`
          : "ready";
      }
      fit();
    }

    function isRequired(name) {
      return inputs.some(
        (i) => i.dataset.variable === name && i.dataset.hasDefault === "false",
      );
    }

    function rendered() {
      const map = values();
      let length = size(template);
      for (const match of template.matchAll(PLACEHOLDER)) {
        length += size(map.get(match[1]) ?? "") - size(match[0]);
        if (length > LIMIT) return undefined;
      }
      return template.replace(PLACEHOLDER, (_, name) => map.get(name) ?? "");
    }

    function open(show) {
      if (!panel || !toggle) return;
      panel.hidden = !show;
      toggle.setAttribute("aria-expanded", String(show));
    }

    function reset() {
      for (const input of inputs) input.value = input.dataset.default ?? "";
      say("");
      draw();
    }

    toggle?.addEventListener("click", () => {
      const show = panel.hidden;
      open(show);
      if (show) inputs[0]?.focus();
    });
    block.querySelector("[data-reset]")?.addEventListener("click", () => {
      reset();
      inputs[0]?.focus();
    });
    for (const input of inputs)
      input.addEventListener("input", () => {
        say("");
        draw();
      });
    more?.addEventListener("click", () => {
      expanded = !expanded;
      fit();
    });

    copy.addEventListener("click", async () => {
      const gaps = missing();
      if (gaps.length) {
        open(true);
        gaps[0].focus();
        say(`Fill ${gaps[0].dataset.variable} to copy`, "warn", 4000);
        return;
      }
      const text = rendered();
      if (text === undefined) {
        say("Rendered prompt exceeds 4 MiB", "warn", 5000);
        return;
      }
      try {
        if (!navigator.clipboard?.writeText) throw new Error("unavailable");
        await navigator.clipboard.writeText(text);
        copy.classList.add("done");
        say("Copied", "ok", 2000);
      } catch {
        expanded = true;
        fit();
        const range = document.createRange();
        range.selectNodeContents(pre);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        pre.focus();
        say("Clipboard blocked. Text selected; press Ctrl/⌘ C", "warn", 6000);
      }
    });

    window.addEventListener("pagehide", reset);
    window.addEventListener("pageshow", reset);
    reset();
    return fit;
  }

  for (const block of document.querySelectorAll("[data-prompt]")) {
    const fit = setup(block);
    block.addEventListener("notebook:reveal", fit);
  }
})();
