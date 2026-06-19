/**
 * Timezone-aware wall-clock <-> UTC conversion, using `Intl` only (the
 * dashboard has `date-fns` but NOT `date-fns-tz`, and no extra dependency is
 * warranted for this).
 *
 * A pricelist's `startDate` / `endDate` are stored as absolute UTC instants.
 * The merchandiser edits them as a wall-clock (date + time) **in the list's
 * IANA timezone** (`PriceList.timezone`), so the form converts on the way in
 * (UTC -> zoned wall-clock) and on the way out (zoned wall-clock -> UTC).
 *
 * Keeping the stored value an absolute instant means the server's validity
 * check stays a plain `start <= nowUtc <= end` comparison — no timezone math
 * on the lookup hot path.
 */

/**
 * Offset, in milliseconds, that `timeZone` is ahead of UTC at the given
 * absolute `instant` (handles DST because it asks `Intl` for the actual
 * wall-clock the zone shows at that instant).
 */
function tzOffsetMs(instant: Date, timeZone: string): number {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
    const p: Record<string, string> = {};
    for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
    // Some engines render midnight as hour '24'.
    const hour = p.hour === '24' ? '00' : p.hour;
    const asUtc = Date.UTC(
        Number(p.year),
        Number(p.month) - 1,
        Number(p.day),
        Number(hour),
        Number(p.minute),
        Number(p.second),
    );
    return asUtc - instant.getTime();
}

/**
 * Interpret `date` ("YYYY-MM-DD") + `time` ("HH:mm") as a wall-clock in
 * `timeZone` and return the matching absolute UTC ISO string.
 */
export function zonedWallClockToUtcIso(
    date: string,
    time: string,
    timeZone: string,
): string {
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = (time || '00:00').split(':').map(Number);
    const naiveUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
    // Two passes so we land correctly even right around a DST transition.
    let offset = tzOffsetMs(new Date(naiveUtc), timeZone);
    offset = tzOffsetMs(new Date(naiveUtc - offset), timeZone);
    return new Date(naiveUtc - offset).toISOString();
}

/**
 * Convert an absolute UTC ISO string to the wall-clock { date, time } the
 * given `timeZone` shows for it.
 */
export function utcIsoToZonedWallClock(
    iso: string,
    timeZone: string,
): { date: string; time: string } {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
    const p: Record<string, string> = {};
    for (const part of dtf.formatToParts(new Date(iso))) p[part.type] = part.value;
    const hour = p.hour === '24' ? '00' : p.hour;
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}` };
}
