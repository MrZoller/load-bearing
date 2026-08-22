export type TerminalInputMode = "tui" | "bash";

interface HistoryCursor {
  readonly entries: string[];
  index: number;
  draft: string;
}

export interface TerminalHistory {
  record(mode: TerminalInputMode, value: string): void;
  previous(mode: TerminalInputMode, draft: string): string;
  next(mode: TerminalInputMode, draft: string): string;
  reset(mode: TerminalInputMode): void;
}

function createCursor(entries: readonly string[]): HistoryCursor {
  const captured = [...entries];
  return { entries: captured, index: captured.length, draft: "" };
}

/**
 * Keep arrow history as presentation state with mode provenance.
 *
 * Engine shell history deliberately includes shell work initiated from TUI and
 * authored agent effects, so deriving this cursor from that slice would leak
 * commands into the wrong prompt. Only visitor submissions enter these lists.
 */
export function createTerminalHistory(
  initialBashEntries: readonly string[] = [],
): TerminalHistory {
  const cursors: Record<TerminalInputMode, HistoryCursor> = {
    tui: createCursor([]),
    bash: createCursor(
      initialBashEntries.filter((entry) => entry.trim() !== ""),
    ),
  };

  function reset(mode: TerminalInputMode): void {
    const cursor = cursors[mode];
    cursor.index = cursor.entries.length;
    cursor.draft = "";
  }

  return {
    record(mode, value) {
      if (value.trim() === "") {
        reset(mode);
        return;
      }
      cursors[mode].entries.push(value);
      reset(mode);
    },
    previous(mode, draft) {
      const cursor = cursors[mode];
      if (cursor.entries.length === 0) return draft;
      if (cursor.index === cursor.entries.length) cursor.draft = draft;
      cursor.index = Math.max(0, cursor.index - 1);
      return cursor.entries[cursor.index] ?? cursor.draft;
    },
    next(mode, draft) {
      const cursor = cursors[mode];
      if (cursor.entries.length === 0) return draft;
      if (cursor.index === cursor.entries.length) return draft;
      cursor.index += 1;
      return cursor.index === cursor.entries.length
        ? cursor.draft
        : (cursor.entries[cursor.index] ?? cursor.draft);
    },
    reset,
  };
}
