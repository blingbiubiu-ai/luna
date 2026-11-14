export type CalendarRule = {
  kind: "daily" | "weekdays" | "weekly" | "custom";
  time: string;
  days: number[];
  frequency?: "hourly" | "daily" | "weekly" | "monthly" | "yearly" | undefined;
  every?: number | undefined;
  startDate?: string | undefined;
  monthDays?: number[] | undefined;
  dayOfMonth?: number | undefined;
  month?: number | undefined;
};
const dayMs = 86400000;
const hourMs = 3600000;
/** Wall-clock recurrence. Missing dates/times are skipped; ambiguous DST times run once. */
export function calendarOccurrence(rule: CalendarRule, timezone: string, boundary: number, direction: "next" | "previous" = "next"): number {
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = (at: number) => Object.fromEntries(formatter.formatToParts(at).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)])) as Record<string, number>;
  const wall = (at: number) => { const p = parts(at); return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!); };
  const currentWall = wall(boundary);
  const current = new Date(currentWall);
  const [hour, minute] = rule.time.split(":").map(Number);
  const time = hour! * hourMs + minute! * 60000;
  // Old custom rules remain weekly with interval 1 and no lower bound.
  const custom = rule.kind === "custom" && rule.frequency !== undefined;
  const frequency = custom ? rule.frequency! : rule.kind === "daily" || rule.kind === "weekdays" ? "daily" : "weekly";
  const step = custom ? rule.every ?? 1 : 1;
  const anchorDay = custom ? Date.parse(`${rule.startDate}T00:00:00Z`) : Date.UTC(1970, 0, 5);
  const anchor = new Date(anchorDay);
  const lowerBound = custom ? anchorDay + time : -Infinity;
  const monday = (value: number) => value - ((new Date(value).getUTCDay() + 6) % 7) * dayMs;
  const monthIndex = (date: Date) => date.getUTCFullYear() * 12 + date.getUTCMonth();
  const base = frequency === "hourly" ? anchorDay + time : frequency === "weekly" ? monday(anchorDay) : anchorDay;
  const unit = frequency === "hourly" ? hourMs : frequency === "weekly" ? 7 * dayMs : dayMs;
  const distance = frequency === "monthly" ? monthIndex(current) - monthIndex(anchor) : frequency === "yearly" ? current.getUTCFullYear() - anchor.getUTCFullYear() : (currentWall - base) / unit;
  let period = Math.floor(distance / step);
  if (custom && direction === "next") period = Math.max(0, period);
  for (let i = 0; i < 40; i++, period += direction === "next" ? 1 : -1) {
    if (custom && period < 0) break;
    let targets: number[];
    if (frequency === "monthly" || frequency === "yearly") {
      const index = monthIndex(anchor) + period * step;
      const year = frequency === "monthly" ? Math.floor(index / 12) : anchor.getUTCFullYear() + period * step;
      const month = frequency === "monthly" ? ((index % 12) + 12) % 12 : (rule.month ?? anchor.getUTCMonth() + 1) - 1;
      const monthDays = rule.monthDays ?? [rule.dayOfMonth ?? anchor.getUTCDate()];
      targets = [...new Set(monthDays)].map(day => Date.UTC(year, month, day) + time)
        .filter(target => new Date(target).getUTCMonth() === month);
    } else if (frequency === "weekly") {
      const start = base + period * step * unit;
      targets = rule.days.map(day => start + ((day + 6) % 7) * dayMs + time);
    } else {
      const target = base + period * step * unit + (frequency === "hourly" ? 0 : time);
      const weekday = new Date(target).getUTCDay();
      targets = rule.kind === "weekdays" && (weekday === 0 || weekday === 6) ? [] : [target];
    }
    const occurrences: number[] = [];
    for (const target of targets) {
      if (target < lowerBound) continue;
      const offsets = new Set([-dayMs, 0, dayMs].map(delta => wall(target + delta) - (target + delta)));
      const candidates = [...offsets].map(offset => target - offset).filter(at => wall(at) === target).sort((a,b) => a-b);
      const first = candidates[0];
      if (first !== undefined && (direction === "next" ? first > boundary : first <= boundary)) occurrences.push(first);
    }
    if (occurrences.length) return direction === "next" ? Math.min(...occurrences) : Math.max(...occurrences);
  }
  throw new Error("No eligible occurrence for this recurrence and boundary");
}
