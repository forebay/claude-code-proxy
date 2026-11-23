const PRIMARY_LOCALE = "en-US";
const FALLBACK_LOCALE = "en-GB";
const OFFSET_NAME = /^GMT[+-]/;
const MINUTE_MILLISECONDS = 60_000;

export interface Zone {
  readonly offset_minutes: number;
  readonly zone: string;
}

function partsOf(locale: string, timeZone: string, instant: number): Intl.DateTimeFormatPart[] {
  const format = new Intl.DateTimeFormat(locale, {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    timeZoneName: "short",
  });
  return format.formatToParts(instant);
}

function partValue(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

/**
 * @implNote en-US names only the zones that have an American abbreviation and spells the rest as an offset; en-GB
 * supplies the local one (CEST) for those. A zone neither names stays an offset.
 */
function zoneName(timeZone: string, instant: number): string {
  const primary = partValue(partsOf(PRIMARY_LOCALE, timeZone, instant), "timeZoneName");
  if (!OFFSET_NAME.test(primary)) return primary;
  const fallback = partValue(partsOf(FALLBACK_LOCALE, timeZone, instant), "timeZoneName");
  return OFFSET_NAME.test(fallback) ? primary : fallback;
}

function offsetMinutes(timeZone: string, instant: number): number {
  const parts = partsOf(PRIMARY_LOCALE, timeZone, instant);
  const number = (type: Intl.DateTimeFormatPartTypes): number => Number(partValue(parts, type));
  const local = Date.UTC(number("year"), number("month") - 1, number("day"), number("hour"), number("minute"), number("second"));
  const whole = instant - (instant % 1000);
  return Math.round((local - whole) / MINUTE_MILLISECONDS);
}

/** The machine's zone at `instant`: its offset from UTC and its short name, which C names a reset in. */
export function zoneAt(instant: number): Zone {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { offset_minutes: offsetMinutes(timeZone, instant), zone: zoneName(timeZone, instant) };
}
