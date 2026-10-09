// Sunrise and sunset from the NOAA solar equations. Accurate to a few minutes, which is all a
// traveller needs to know whether they land in daylight.
const rad = Math.PI / 180;

function julianDay(date: Date): number {
  return date.getTime() / 86_400_000 + 2440587.5;
}

/** Returns UTC Dates for sunrise and sunset on the given day, or null above the polar circles. */
export function sunTimes(lat: number, lon: number, date = new Date()): { sunrise: Date; sunset: Date } | null {
  const day = Math.floor(julianDay(date) - 2451545 + 0.0008);
  const meanSolarTime = day - lon / 360;
  const meanAnomaly = (357.5291 + 0.98560028 * meanSolarTime) % 360;
  const centre = 1.9148 * Math.sin(meanAnomaly * rad) + 0.02 * Math.sin(2 * meanAnomaly * rad) + 0.0003 * Math.sin(3 * meanAnomaly * rad);
  const eclipticLon = (meanAnomaly + centre + 180 + 102.9372) % 360;
  const transit = 2451545 + meanSolarTime + 0.0053 * Math.sin(meanAnomaly * rad) - 0.0069 * Math.sin(2 * eclipticLon * rad);
  const declination = Math.asin(Math.sin(eclipticLon * rad) * Math.sin(23.4397 * rad));
  const cosHour = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(declination)) / (Math.cos(lat * rad) * Math.cos(declination));
  if (cosHour < -1 || cosHour > 1) return null;
  const hourAngle = Math.acos(cosHour) / rad / 360;
  const toDate = (jd: number) => new Date((jd - 2440587.5) * 86_400_000);
  return { sunrise: toDate(transit - hourAngle), sunset: toDate(transit + hourAngle) };
}

/** Minutes east of UTC for an IANA zone right now; null when the zone is unknown. */
export function tzOffsetMinutes(tz: string, now = new Date()): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    return Math.round((asUtc - now.getTime()) / 60_000 / 5) * 5;
  } catch {
    return null;
  }
}
