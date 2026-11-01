import { MEMBER_COMMANDS } from './bot-data';
import type { PersonalUsage } from './types';

const DAY_MS = 86_400_000;
const categories = ['general', 'media', 'vault', 'other'] as const;
export type UsageCategory = typeof categories[number];

/** Days without a sample are unknown, not zero. All buckets use UTC. */
export function memberAnalytics(usage: PersonalUsage, now = Date.now()) {
  const today = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00.000Z');
  const firstTrackedDay = new Date(usage.trackedSince).toISOString().slice(0, 10);
  const lastSampleDay = new Date(usage.updatedAt).toISOString().slice(0, 10);
  const data = new Map(usage.days.map((day) => [day.date, day.commands]));
  const days = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(today - (13 - index) * DAY_MS).toISOString().slice(0, 10);
    const tracked = date >= firstTrackedDay && date <= lastSampleDay;
    const commands = tracked ? (data.get(date) || {}) : {};
    const total = tracked ? Object.values(commands).reduce((sum, count) => sum + count, 0) : null;
    return { date, tracked, commands, total };
  });
  const current = days.slice(7);
  const previous = days.slice(0, 7);
  const totals: Record<string, number> = Object.create(null);
  for (const day of current) for (const [name, count] of Object.entries(day.commands)) totals[name] = (totals[name] || 0) + count;
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const categoryCounts: Record<UsageCategory, number> = { general: 0, media: 0, vault: 0, other: 0 };
  for (const [name, count] of top) {
    const category = MEMBER_COMMANDS.find((item) => item.name === name || item.aliases.includes(name))?.category;
    if (category === 'general' || category === 'media' || category === 'vault') categoryCounts[category] += count;
    else categoryCounts.other += count;
  }
  return {
    days: current,
    total: current.reduce((sum, day) => sum + (day.total || 0), 0),
    activeDays: current.filter((day) => (day.total || 0) > 0).length,
    measuredDays: current.filter((day) => day.tracked).length,
    previousTotal: previous.every((day) => day.tracked) && current.every((day) => day.tracked) && usage.trackedSince <= today - 13 * DAY_MS
      ? previous.reduce((sum, day) => sum + (day.total || 0), 0) : null,
    top,
    categoryCounts,
    categories,
  };
}
