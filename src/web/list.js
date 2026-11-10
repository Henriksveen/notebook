(() => {
  const filter = document.querySelector("#list-filter");
  const count = document.querySelector("#list-count");
  const empty = document.querySelector("#list-empty");
  if (!filter || !count || !empty) return;
  const items = [...document.querySelectorAll("[data-filter-item]")];
  const noun = count.dataset.noun ?? "item";
  const unit = (n) => (n === 1 ? noun : `${noun}s`);

  function apply() {
    const terms = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const item of items) {
      const haystack =
        `${item.dataset.search ?? ""} ${item.dataset.template ?? ""}`.toLowerCase();
      const match = terms.every((term) => haystack.includes(term));
      const reveal = match && item.hidden;
      item.hidden = !match;
      if (reveal) item.dispatchEvent(new Event("notebook:reveal"));
      if (match) shown += 1;
    }
    count.textContent = terms.length
      ? `${shown} of ${items.length}`
      : `${items.length} ${unit(items.length)}`;
    empty.hidden = shown > 0;
  }

  filter.addEventListener("input", apply);
  document.querySelector("#list-clear")?.addEventListener("click", () => {
    filter.value = "";
    apply();
    filter.focus();
  });
  for (const button of document.querySelectorAll("[data-filter-value]"))
    button.addEventListener("click", () => {
      const value = button.dataset.filterValue ?? "";
      filter.value = filter.value === value ? "" : value;
      apply();
    });
  apply();
})();
