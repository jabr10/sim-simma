// Upcoming-game filter: kickoff is nflverse gameday + gametime in US Eastern.
// `played` (final result on the game file) is a backup when kickoff is missing.

export const KICKOFF_TZ = "America/New_York";
export const GAME_UNAVAILABLE = "This game is no longer available to simulate.";

export interface KickoffFields {
  gameday?: string | null;
  gametime?: string | null;
  played?: boolean;
}

/**
 * True when the game has not started yet (kickoff still in the future).
 * In-progress and final games are not simulatable.
 */
export function isUpcomingGame(game: KickoffFields, now: Date = new Date()): boolean {
  if (game.played === true) return false;
  const start = kickoffInstant(game.gameday, game.gametime);
  if (!start) return false;
  return start.getTime() > now.getTime();
}

export function upcomingGames<T extends KickoffFields>(games: T[], now: Date = new Date()): T[] {
  return games.filter((g) => isUpcomingGame(g, now));
}

/**
 * Instant of kickoff. `gametime` is Eastern (same as the UI).
 * If time is missing, treat kickoff as the end of that Eastern calendar day so
 * a date-only row is not hidden at midnight, and is gone once the day is over
 * (or sooner if `played` is set).
 */
export function kickoffInstant(
  gameday: string | null | undefined,
  gametime: string | null | undefined,
): Date | null {
  if (!gameday || !/^\d{4}-\d{2}-\d{2}$/.test(gameday)) return null;
  const hms = normalizeTime(gametime);
  if (!hms) return null;
  return zonedCivilTimeToDate(gameday, hms, KICKOFF_TZ);
}

function normalizeTime(gametime: string | null | undefined): string | null {
  if (!gametime || !gametime.trim()) return "23:59:59";
  const parts = gametime.trim().split(":");
  const hour = Number(parts[0]);
  const minute = Number(parts[1] ?? 0);
  const second = Number(parts[2] ?? 0);
  if (![hour, minute, second].every((n) => Number.isFinite(n))) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  return `${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Interpret a civil date/time in `timeZone` as a UTC Date (DST-safe). */
function zonedCivilTimeToDate(ymd: string, hms: string, timeZone: string): Date | null {
  const [year, month, day] = ymd.split("-").map(Number);
  const [hour, minute, second] = hms.split(":").map(Number);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = asUtc;
  for (let i = 0; i < 2; i++) {
    const offset = offsetMsAt(new Date(instant), timeZone);
    if (offset === null) return null;
    instant = asUtc - offset;
  }
  return new Date(instant);
}

function offsetMsAt(instant: Date, timeZone: string): number | null {
  const parts = civilPartsInZone(instant, timeZone);
  if (!parts) return null;
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - instant.getTime();
}

function civilPartsInZone(instant: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} | null {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(instant)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  let hour = Number(map.hour);
  const minute = Number(map.minute);
  const second = Number(map.second);
  if (hour === 24) hour = 0;
  if (![year, month, day, hour, minute, second].every((n) => Number.isFinite(n))) return null;
  return { year, month, day, hour, minute, second };
}
