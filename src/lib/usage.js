// Usage numbers for the owner's dashboard (Settings › Testing › Usage): who is using A2B, how busy it got and
// whether people were turned away. Kept per day (Malaysia time) and only as counts plus one row per device
// per day, so it stays tiny; rows older than USAGE_DAYS are cleared by the daily clean-up.

import { ACTIVE_MS } from './presence.js';

export const USAGE_DAYS = 30;
const COUNTERS = new Set(['signups', 'routes', 'searches']);

export const dayOf = (now = Date.now()) => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);

export function usageRepo(db) {
  return {
    // A route, search or sign-up happened.
    async bump(field, now = Date.now()) {
      if (!COUNTERS.has(field)) return;
      await db
        .prepare(`INSERT INTO usage_daily (day, ${field}) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET ${field} = ${field} + 1`)
        .bind(dayOf(now))
        .run();
    },

    // After a check-in: the device was here today (and whether it was turned away), and maybe a new busiest moment.
    async sawDevice(device, user, { admitted, active }, now = Date.now()) {
      const day = dayOf(now);
      await db.batch([
        db
          .prepare(
            `INSERT INTO usage_devices (day, device, account, turned_away) VALUES (?, ?, ?, ?)
             ON CONFLICT(day, device) DO UPDATE SET account = MAX(account, excluded.account), turned_away = MAX(turned_away, excluded.turned_away)`,
          )
          .bind(day, device, user ? 1 : 0, admitted ? 0 : 1),
        db.prepare('INSERT INTO usage_daily (day, peak_active, peak_at) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET peak_at = CASE WHEN excluded.peak_active > peak_active THEN excluded.peak_at ELSE peak_at END, peak_active = MAX(peak_active, excluded.peak_active)').bind(day, active, now),
      ]);
    },

    async report(lim, now = Date.now()) {
      const since = dayOf(now - 13 * 86400_000);
      const [live, days, devices, totals] = await Promise.all([
        db
          .prepare(
            `SELECT COALESCE(SUM(admitted = 1), 0) AS active, COALESCE(SUM(admitted = 1 AND user_id IS NOT NULL), 0) AS accounts,
                    COALESCE(SUM(admitted = 0), 0) AS waiting
             FROM presence WHERE last_seen > ?`,
          )
          .bind(now - ACTIVE_MS)
          .first(),
        db.prepare('SELECT * FROM usage_daily WHERE day >= ? ORDER BY day').bind(since).all(),
        db
          .prepare('SELECT day, COUNT(*) AS devices, SUM(account) AS accounts, SUM(turned_away) AS turned_away FROM usage_devices WHERE day >= ? GROUP BY day')
          .bind(since)
          .all(),
        db.prepare('SELECT (SELECT COUNT(*) FROM users) AS accounts, (SELECT COUNT(*) FROM reports) AS reports').first(),
      ]);
      const byDay = new Map();
      for (let i = 13; i >= 0; i--) {
        const day = dayOf(now - i * 86400_000);
        byDay.set(day, { day, devices: 0, accounts: 0, turned_away: 0, peak_active: 0, peak_at: null, signups: 0, routes: 0, searches: 0 });
      }
      for (const r of days.results) Object.assign(byDay.get(r.day) ?? {}, r);
      for (const r of devices.results) Object.assign(byDay.get(r.day) ?? {}, r);
      return {
        now: { ...live, guests: live.active - live.accounts, max: lim.total, guest_max: lim.guests },
        days: [...byDay.values()],
        totals,
      };
    },
  };
}
