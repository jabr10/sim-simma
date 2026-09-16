const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function kickoff(gameday: string, gametime: string | null): string {
  const d = new Date(`${gameday}T12:00:00`);
  let time = "";
  if (gametime) {
    const [hh, mm] = gametime.split(":");
    const h = Number(hh);
    time = ` ${((h + 11) % 12) + 1}:${mm} ${h >= 12 ? "pm" : "am"} ET`;
  }
  return `${DAYS[d.getDay()]}${time}`;
}

export function favoriteText(home: string, away: string, spreadHome: number | null): string {
  if (spreadHome == null) return "No line yet";
  if (spreadHome === 0) return "Pick'em";
  return `${spreadHome > 0 ? home : away} by ${Math.abs(spreadHome)}`;
}

export const pct = (v: number, digits = 0) => `${(v * 100).toFixed(digits)}%`;
export const f1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
