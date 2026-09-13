/**
 * The HUD clock, in the viewer's own time zone.
 *
 * Kept out of the component so the awkward parts — the ones that only misbehave
 * on a particular engine, at a particular hour, in a particular zone — can be
 * asserted directly rather than inferred from a rendered string once an hour.
 */

export interface Reading {
  /** Zero-padded 24-hour time: HH:MM:SS. */
  time: string;
  /** The zone abbreviation the platform gives, e.g. EDT, JST, GMT+5:30. */
  zone: string;
}

/**
 * Builds the formatter once and returns a reader for it.
 *
 * `hour12` is forced off because it otherwise follows the locale, and every
 * other timestamp in this app — position ages, alert times, satellite epochs —
 * is 24-hour. A clock that disagreed with them would be worse than no clock.
 *
 * The zone label is pulled from the same formatter that produced the digits, so
 * the two cannot fall out of step across a daylight-saving boundary: format the
 * time with one and label it with another and, for one hour twice a year, the
 * app confidently states the wrong thing.
 */
export function clock(
  timeZone?: string,
  locale?: string,
): (at: Date) => Reading {
  const format = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  });

  return (at: Date): Reading => {
    const parts = format.formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((candidate) => candidate.type === type)?.value ?? "";

    // hour12:false resolves to the h23 cycle on every engine that matters, but
    // Safari has shipped "24" for midnight, and some locales carry an h24
    // default that survives the option. Either way the answer is 00, not a
    // twenty-fourth hour.
    const hour = part("hour");

    return {
      time: `${hour === "24" ? "00" : hour}:${part("minute")}:${part("second")}`,
      zone: part("timeZoneName"),
    };
  };
}
