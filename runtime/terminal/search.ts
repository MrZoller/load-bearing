export interface TranscriptSearch {
  readonly element: HTMLElement;
  refresh(): void;
}

function isSearchShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key === "f";
}

/** Presentation-only transcript search that leaves rendered text untouched. */
export function createTranscriptSearch(
  document: Document,
  transcript: HTMLOListElement,
  restoreFocus: () => void,
): TranscriptSearch {
  const search = document.createElement("section");
  search.className = "transcript-search";
  search.hidden = true;
  search.setAttribute("aria-label", "Transcript search");

  const label = document.createElement("label");
  label.className = "transcript-search__label";
  label.textContent = "Find";

  const input = document.createElement("input");
  input.className = "transcript-search__input";
  input.type = "search";
  input.setAttribute("aria-label", "Search transcript");
  label.append(input);

  const status = document.createElement("p");
  status.className = "transcript-search__status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-label", "Transcript search status");

  search.append(label, status);

  let matches: HTMLElement[] = [];
  let current = -1;

  function clearCurrent(): void {
    for (const match of matches) {
      match.classList.remove("transcript__entry--search-match");
      match.removeAttribute("aria-current");
    }
  }

  function showCurrent(): void {
    clearCurrent();
    if (matches.length === 0) {
      status.textContent =
        input.value.length === 0 ? "Type to search" : "No matches";
      return;
    }
    const match = matches[current];
    if (match === undefined) return;
    const query = input.value.trim().toLocaleLowerCase();
    for (const detail of match.querySelectorAll<HTMLDetailsElement>(
      "details:not([open])",
    )) {
      if ((detail.textContent ?? "").toLocaleLowerCase().includes(query))
        detail.open = true;
    }
    match.classList.add("transcript__entry--search-match");
    match.setAttribute("aria-current", "true");
    status.textContent = `${String(current + 1)} of ${String(matches.length)}`;
    match.scrollIntoView({ block: "nearest" });
  }

  function refresh(): void {
    const currentKey = matches[current]?.dataset["transcriptKey"];
    const priorIndex = current;
    clearCurrent();
    const query = input.value.trim().toLocaleLowerCase();
    matches =
      query.length === 0
        ? []
        : Array.from(transcript.children).filter(
            (entry): entry is HTMLElement =>
              entry instanceof HTMLElement &&
              (entry.textContent ?? "").toLocaleLowerCase().includes(query),
          );
    const restoredIndex = matches.findIndex(
      (match) => match.dataset["transcriptKey"] === currentKey,
    );
    current =
      matches.length === 0
        ? -1
        : restoredIndex >= 0
          ? restoredIndex
          : Math.min(Math.max(priorIndex, 0), matches.length - 1);
    showCurrent();
  }

  function close(): void {
    clearCurrent();
    input.value = "";
    matches = [];
    current = -1;
    status.textContent = "";
    search.hidden = true;
    restoreFocus();
  }

  function open(): void {
    search.hidden = false;
    input.focus();
    input.select();
    refresh();
  }

  document.addEventListener("keydown", (event) => {
    if (!isSearchShortcut(event)) return;
    event.preventDefault();
    open();
  });
  input.addEventListener("input", refresh);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Enter" || matches.length === 0) return;
    event.preventDefault();
    current =
      (current + (event.shiftKey ? matches.length - 1 : 1)) % matches.length;
    showCurrent();
  });

  return { element: search, refresh };
}
