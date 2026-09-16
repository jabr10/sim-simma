/** Map nflverse / schedule abbreviations to ESPN logo slug. */
const ESPN_SLUG: Record<string, string> = {
  ARI: "ari",
  ATL: "atl",
  BAL: "bal",
  BUF: "buf",
  CAR: "car",
  CHI: "chi",
  CIN: "cin",
  CLE: "cle",
  DAL: "dal",
  DEN: "den",
  DET: "det",
  GB: "gb",
  HOU: "hou",
  IND: "ind",
  JAX: "jax",
  KC: "kc",
  LA: "lar",
  LAR: "lar",
  LAC: "lac",
  LV: "lv",
  MIA: "mia",
  MIN: "min",
  NE: "ne",
  NO: "no",
  NYG: "nyg",
  NYJ: "nyj",
  PHI: "phi",
  PIT: "pit",
  SEA: "sea",
  SF: "sf",
  TB: "tb",
  TEN: "ten",
  WAS: "wsh",
  WSH: "wsh",
};

export function teamLogoUrl(abbr: string): string | null {
  const slug = ESPN_SLUG[abbr.toUpperCase()];
  if (!slug) return null;
  return `https://a.espncdn.com/i/teamlogos/nfl/500/${slug}.png`;
}
