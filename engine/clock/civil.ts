/**
 * Civil time from an epoch, computed by hand in UTC.
 *
 * The engine has no `Date` (invariant 2) and no `Intl` (both are banned by the
 * purity gate), so calendar arithmetic and timestamp formatting live here.
 * That is not a workaround — it is the point. `Date`'s formatting reads the
 * host timezone, and `Intl`'s reads the host locale, so a `git log` rendered
 * on a laptop in Tokyo would differ from the same session rendered in CI. The
 * simulated machine is always in UTC, always in the C locale, and always says
 * so.
 *
 * Everything here is integer arithmetic on an epoch-milliseconds number.
 *
 * The month and weekday tables are the abbreviations `git log` and `ls -l`
 * print under `LC_ALL=C`, which is what the simulated shell is imitating.
 * Subsystems build their own formats from `CivilTime` plus these tables;
 * this module owns only the ISO form, which is the one the engine itself
 * records.
 */

/** UTC calendar fields for an instant. */
export interface CivilTime {
  /** Four-digit year, 1970 through 9999. */
  readonly year: number;
  /** 1 through 12. */
  readonly month: number;
  /** 1 through 31. */
  readonly day: number;
  /** 0 through 23. */
  readonly hour: number;
  /** 0 through 59. */
  readonly minute: number;
  /** 0 through 59. Leap seconds do not exist here; see `parseTimestamp`. */
  readonly second: number;
  /** 0 through 999. */
  readonly millisecond: number;
  /** 0 is Sunday, matching `WEEKDAY_NAMES`. */
  readonly weekday: number;
}

/** The calendar fields an instant can be built from. Time defaults to 00:00. */
export interface CivilInput {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour?: number;
  readonly minute?: number;
  readonly second?: number;
  readonly millisecond?: number;
}

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60000;
export const MS_PER_HOUR = 3600000;
export const MS_PER_DAY = 86400000;

/**
 * The representable range: 1970-01-01T00:00:00.000Z through
 * 9999-12-31T23:59:59.999Z.
 *
 * Bounded at both ends on purpose. Below zero the simulated world would be
 * printing dates before the epoch it is denominated in, which is a bug in
 * whatever produced the number rather than a feature. Above 9999 the year no
 * longer fits the four digits every format here assumes, and a timestamp that
 * silently widens is worse than one that refuses.
 */
export const MIN_EPOCH_MS = 0;
export const MAX_EPOCH_MS = 253402300799999;

/** C-locale month abbreviations, indexed from January at 0. */
export const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** C-locale weekday abbreviations, indexed from Sunday at 0. */
export const WEEKDAY_NAMES = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

/** Days from 1970-01-01 to 0000-03-01, the epoch the era arithmetic uses. */
const DAYS_TO_INTERNAL_EPOCH = 719468;
/** Days in a 400-year Gregorian era. */
const DAYS_PER_ERA = 146097;

const TIMESTAMP_SHAPE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function assertEpochMs(epochMs: number, what: string): number {
  if (
    !Number.isInteger(epochMs) ||
    epochMs < MIN_EPOCH_MS ||
    epochMs > MAX_EPOCH_MS
  ) {
    throw new Error(
      `clock: ${what} must be an integer in [${String(MIN_EPOCH_MS)}, ${String(MAX_EPOCH_MS)}] milliseconds, got ${String(epochMs)}`,
    );
  }
  return epochMs;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Decompose epoch milliseconds into UTC calendar fields.
 *
 * The date half is Howard Hinnant's `civil_from_days`: shift the epoch to
 * 0000-03-01 so leap day lands at the end of a year, then divide the days into
 * 400-year eras, which is the cycle the Gregorian calendar actually repeats
 * on. It is closed-form integer arithmetic — no lookup tables, no loop over
 * years, and no branch on leap years at all.
 */
export function civilFromEpochMs(epochMs: number): CivilTime {
  assertEpochMs(epochMs, "timestamp");

  const days = Math.floor(epochMs / MS_PER_DAY);
  const timeOfDay = epochMs - days * MS_PER_DAY;

  const shifted = days + DAYS_TO_INTERNAL_EPOCH;
  const era = Math.floor(shifted / DAYS_PER_ERA);
  const dayOfEra = shifted - era * DAYS_PER_ERA;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  const dayOfYear =
    dayOfEra -
    (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  // Months numbered from March, which is what puts leap day last.
  const marchMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * marchMonth + 2) / 5) + 1;
  const month = marchMonth + (marchMonth < 10 ? 3 : -9);
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);

  return {
    year,
    month,
    day,
    hour: Math.floor(timeOfDay / MS_PER_HOUR),
    minute: Math.floor(timeOfDay / MS_PER_MINUTE) % 60,
    second: Math.floor(timeOfDay / MS_PER_SECOND) % 60,
    millisecond: timeOfDay % MS_PER_SECOND,
    // 1970-01-01 was a Thursday, which is index 4 in `WEEKDAY_NAMES`.
    weekday: (days + 4) % 7,
  };
}

/**
 * Compose epoch milliseconds from UTC calendar fields.
 *
 * The inverse of `civilFromEpochMs`, by the same era arithmetic. Rejects
 * out-of-range fields rather than normalizing them: a `day` of 32 is an
 * authoring mistake, and rolling it into the next month would hide it.
 */
export function epochMsFromCivil(civil: CivilInput): number {
  // Every field captured before any is validated. The optional four already
  // were; `year`, `month` and `day` were read once for the bounds check and
  // several times afterwards, so a getter could satisfy the range and then
  // supply something else to the arithmetic. Reachable only from a
  // caller-built `CivilInput` — `parseTimestamp` constructs its own from a
  // regex match — but this is exported API.
  const year = civil.year;
  const month = civil.month;
  const day = civil.day;
  const hour = civil.hour ?? 0;
  const minute = civil.minute ?? 0;
  const second = civil.second ?? 0;
  const millisecond = civil.millisecond ?? 0;

  const bounds: readonly (readonly [string, number, number, number])[] = [
    ["year", year, 1970, 9999],
    ["month", month, 1, 12],
    ["day", day, 1, 31],
    ["hour", hour, 0, 23],
    ["minute", minute, 0, 59],
    ["second", second, 0, 59],
    ["millisecond", millisecond, 0, 999],
  ];
  for (const bound of bounds) {
    const [name, value, low, high] = bound;
    if (!Number.isInteger(value) || value < low || value > high) {
      throw new Error(
        `clock: ${name} must be an integer in [${String(low)}, ${String(high)}], got ${String(value)}`,
      );
    }
  }
  if (day > daysInMonth(year, month)) {
    throw new Error(
      `clock: ${String(year)}-${pad(month, 2)} has ${String(daysInMonth(year, month))} days, got day ${String(day)}`,
    );
  }

  const shiftedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const marchMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * marchMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  const days = era * DAYS_PER_ERA + dayOfEra - DAYS_TO_INTERNAL_EPOCH;

  return (
    days * MS_PER_DAY +
    hour * MS_PER_HOUR +
    minute * MS_PER_MINUTE +
    second * MS_PER_SECOND +
    millisecond
  );
}

/**
 * Render an instant as `YYYY-MM-DDTHH:MM:SS.mmmZ`.
 *
 * Milliseconds are always present, even when zero, so every timestamp the
 * engine records is the same width and `parseTimestamp(formatTimestamp(t))`
 * is exactly `t`. A format that dropped a zero fraction would make two
 * transcripts differ on whether an event happened to land on a whole second.
 */
export function formatTimestamp(epochMs: number): string {
  const civil = civilFromEpochMs(epochMs);
  return (
    `${pad(civil.year, 4)}-${pad(civil.month, 2)}-${pad(civil.day, 2)}` +
    `T${pad(civil.hour, 2)}:${pad(civil.minute, 2)}:${pad(civil.second, 2)}` +
    `.${pad(civil.millisecond, 3)}Z`
  );
}

/**
 * Parse `YYYY-MM-DDTHH:MM:SS[.mmm]Z` into epoch milliseconds.
 *
 * Deliberately narrower than ISO 8601. Only UTC is accepted — a cartridge
 * declaring `+09:00` would be declaring a timezone the simulated machine does
 * not have. A fractional part of one to three digits is accepted and padded;
 * four or more is rejected rather than truncated, because silently dropping
 * precision from an authored timestamp is how two cartridges end up
 * disagreeing about the same instant. Second 60 is rejected: the simulated
 * clock counts milliseconds, and leap seconds do not divide into them.
 */
export function parseTimestamp(text: string): number {
  const match = TIMESTAMP_SHAPE.exec(text);
  if (match === null) {
    throw new Error(
      `clock: timestamp must be YYYY-MM-DDTHH:MM:SS[.mmm]Z in UTC, got ${JSON.stringify(text)}`,
    );
  }

  const [, year, month, day, hour, minute, second, fraction] = match;
  // `epochMsFromCivil` bounds the year to [1970, 9999], which is exactly the
  // representable range, so no separate epoch check is needed here.
  return epochMsFromCivil({
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    millisecond: Number((fraction ?? "0").padEnd(3, "0")),
  });
}
