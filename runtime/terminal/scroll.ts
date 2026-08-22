const MAX_RENDERED_ENTRIES = 200;
const BOTTOM_TOLERANCE_PX = 2;

export interface TranscriptScroll {
  readonly newOutputButton: HTMLButtonElement;
  afterSearchRefresh(): void;
  clear(): void;
  render(entries: readonly HTMLLIElement[]): void;
}

interface VisibleAnchor {
  readonly key: string;
  readonly offset: number;
}

function isAtBottom(transcript: HTMLOListElement): boolean {
  return (
    transcript.scrollTop + transcript.clientHeight >=
    transcript.scrollHeight - BOTTOM_TOLERANCE_PX
  );
}

function visibleAnchor(transcript: HTMLOListElement): VisibleAnchor | null {
  const viewportTop = transcript.getBoundingClientRect().top;
  for (const child of Array.from(transcript.children)) {
    if (!(child instanceof HTMLElement)) continue;
    const key = child.dataset["transcriptKey"];
    const rect = child.getBoundingClientRect();
    if (key !== undefined && rect.bottom >= viewportTop) {
      return { key, offset: rect.top - viewportTop };
    }
  }
  return null;
}

/** Bound rendered history and preserve a reader's viewport across rerenders. */
export function createTranscriptScroll(
  document: Document,
  transcript: HTMLOListElement,
  restoreFocus: () => void,
): TranscriptScroll {
  const newOutputButton = document.createElement("button");
  newOutputButton.className = "transcript__new-output";
  newOutputButton.type = "button";
  newOutputButton.textContent = "New output — jump to latest";
  newOutputButton.hidden = true;

  let previousLastKey: string | undefined;
  let following = true;
  let lastRenderHadNewOutput = false;

  function jumpToLatest(): void {
    following = true;
    transcript.scrollTop = transcript.scrollHeight;
    newOutputButton.hidden = true;
    restoreFocus();
  }

  newOutputButton.addEventListener("click", jumpToLatest);
  transcript.addEventListener("scroll", () => {
    following = isAtBottom(transcript);
    if (following) newOutputButton.hidden = true;
  });

  function render(entries: readonly HTMLLIElement[]): void {
    const wasAtBottom = isAtBottom(transcript);
    const shouldFollow = following && wasAtBottom;
    const anchor = shouldFollow ? null : visibleAnchor(transcript);
    const retained = entries.slice(-MAX_RENDERED_ENTRIES);
    const lastKey = retained.at(-1)?.dataset["transcriptKey"];
    const hasNewOutput =
      previousLastKey !== undefined && lastKey !== previousLastKey;
    lastRenderHadNewOutput = hasNewOutput;

    transcript.replaceChildren(...retained);

    if (shouldFollow) {
      transcript.scrollTop = transcript.scrollHeight;
      newOutputButton.hidden = true;
    } else {
      following = false;
      const anchored =
        anchor === null
          ? null
          : transcript.querySelector<HTMLElement>(
              `[data-transcript-key="${CSS.escape(anchor.key)}"]`,
            );
      if (anchored !== null && anchor !== null) {
        transcript.scrollTop +=
          anchored.getBoundingClientRect().top -
          transcript.getBoundingClientRect().top -
          anchor.offset;
      }
      if (hasNewOutput) newOutputButton.hidden = false;
    }
    previousLastKey = lastKey;
  }

  // Search restores its selected match after scroll rendering. Re-read the
  // viewport then, because that restoration can move a formerly-following
  // reader away from the bottom after render hid the new-output control.
  function afterSearchRefresh(): void {
    following = isAtBottom(transcript);
    if (following) {
      newOutputButton.hidden = true;
    } else if (lastRenderHadNewOutput) {
      newOutputButton.hidden = false;
    }
  }

  function clear(): void {
    transcript.replaceChildren();
    previousLastKey = undefined;
    following = true;
    lastRenderHadNewOutput = false;
    newOutputButton.hidden = true;
  }

  return { newOutputButton, afterSearchRefresh, clear, render };
}
