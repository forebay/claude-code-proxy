const PRIMARY_LOCALE = "en-US";
const FALLBACK_LOCALE = "en-GB";
const OFFSET_NAME = /^GMT[+-]/;

function partsOf(locale: string, timeZone: string, instant: number): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).formatToParts(instant);
}

function partValue(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

/**
 * @implNote en-US names only the zones that have an American abbreviation and spells the rest as an
 * offset, where the JDK's `z` gives the local one (CEST); en-GB supplies those. A zone neither
 * names stays an offset.
 */
function zoneName(timeZone: string, instant: number): string {
  const primary = partValue(partsOf(PRIMARY_LOCALE, timeZone, instant), "timeZoneName");
  if (!OFFSET_NAME.test(primary)) return primary;
  const fallback = partValue(partsOf(FALLBACK_LOCALE, timeZone, instant), "timeZoneName");
  return OFFSET_NAME.test(fallback) ? primary : fallback;
}

/** The instant as `h:mm a z` in the zone, for example `1:51 AM UTC`. */
export function resetTime(instant: number, timeZone: string): string {
  const parts = partsOf(PRIMARY_LOCALE, timeZone, instant);
  return `${partValue(parts, "hour")}:${partValue(parts, "minute")} ${partValue(parts, "dayPeriod")} ${zoneName(timeZone, instant)}`;
}
