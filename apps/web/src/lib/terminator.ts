/**
 * The solar terminator — the line between day and night.
 *
 * Computed in the browser rather than fetched. It is a function of the clock
 * and nothing else, so a network call for it would be a round trip to be told
 * what time it is.
 *
 * The maths is the standard low-precision solar position: solar declination
 * from the day of year, hour angle from UTC time. Good to a fraction of a
 * degree, which is far inside the width of the line as drawn.
 */

const RAD = Math.PI / 180;

function julianDay(date: Date): number {
  return date.getTime() / 86_400_000 + 2440587.5;
}

/** Declination of the sun, in degrees. */
function declination(date: Date): number {
  const n = julianDay(date) - 2451545.0;
  const meanLongitude = (280.46 + 0.9856474 * n) % 360;
  const meanAnomaly = (357.528 + 0.9856003 * n) % 360;
  const eclipticLongitude =
    meanLongitude +
    1.915 * Math.sin(meanAnomaly * RAD) +
    0.02 * Math.sin(2 * meanAnomaly * RAD);

  return Math.asin(Math.sin(23.44 * RAD) * Math.sin(eclipticLongitude * RAD)) / RAD;
}

/** Greenwich hour angle of the sun, in degrees. */
function hourAngle(date: Date): number {
  const utcHours =
    date.getUTCHours() +
    date.getUTCMinutes() / 60 +
    date.getUTCSeconds() / 3600;
  return (utcHours - 12) * 15;
}

/**
 * The night side as a polygon.
 *
 * Built as a ring across all longitudes at the terminator latitude, then
 * closed along whichever pole is currently in darkness — which is what makes
 * it fill correctly through both solstices rather than inverting at the
 * equinox.
 */
export function nightPolygon(now: Date = new Date()): number[][] {
  const dec = declination(now);
  const gha = hourAngle(now);

  const points: number[][] = [];
  for (let i = 0; i <= 360; i += 2) {
    const longitude = -180 + i;
    const hour = (longitude + gha) * RAD;
    // Latitude where the sun is exactly on the horizon at this longitude.
    const latitude =
      Math.atan(-Math.cos(hour) / Math.tan(dec * RAD)) / RAD;
    points.push([longitude, latitude]);
  }

  // Close over the dark pole: northern winter darkens the north.
  const polarLatitude = dec > 0 ? -90 : 90;
  points.push([180, polarLatitude]);
  points.push([-180, polarLatitude]);
  points.push(points[0] as number[]);

  return points;
}
