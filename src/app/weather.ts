// Expected kickoff weather. Indoor/retractable roofs stay local;
// outdoor games use the free Open-Meteo forecast API (no key).

export interface WeatherSummary {
  emoji: string;
  label: string;
}

interface Stadium {
  lat: number;
  lon: number;
  indoor: boolean; // true = dome / fixed indoor / typically closed retractable
}

// Approx stadium coordinates by home team abbreviation.
const STADIUMS: Record<string, Stadium> = {
  ARI: { lat: 33.5276, lon: -112.2626, indoor: true },
  ATL: { lat: 33.7554, lon: -84.4009, indoor: true },
  BAL: { lat: 39.278, lon: -76.6227, indoor: false },
  BUF: { lat: 42.7738, lon: -78.787, indoor: false },
  CAR: { lat: 35.2258, lon: -80.8528, indoor: false },
  CHI: { lat: 41.8623, lon: -87.6167, indoor: false },
  CIN: { lat: 39.0954, lon: -84.516, indoor: false },
  CLE: { lat: 41.5061, lon: -81.6995, indoor: false },
  DAL: { lat: 32.7473, lon: -97.0945, indoor: true },
  DEN: { lat: 39.7439, lon: -105.0201, indoor: false },
  DET: { lat: 42.34, lon: -83.0456, indoor: true },
  GB: { lat: 44.5013, lon: -88.0622, indoor: false },
  HOU: { lat: 29.6847, lon: -95.4107, indoor: true },
  IND: { lat: 39.7601, lon: -86.1639, indoor: true },
  JAX: { lat: 30.3239, lon: -81.6373, indoor: false },
  KC: { lat: 39.0489, lon: -94.4839, indoor: false },
  LA: { lat: 33.9535, lon: -118.339, indoor: false },
  LAC: { lat: 33.9535, lon: -118.339, indoor: false },
  LAR: { lat: 33.9535, lon: -118.339, indoor: false },
  LV: { lat: 36.0908, lon: -115.183, indoor: true },
  MIA: { lat: 25.958, lon: -80.2389, indoor: false },
  MIN: { lat: 44.9738, lon: -93.2577, indoor: true },
  NE: { lat: 42.0909, lon: -71.2643, indoor: false },
  NO: { lat: 29.9511, lon: -90.0812, indoor: true },
  NYG: { lat: 40.8128, lon: -74.0742, indoor: false },
  NYJ: { lat: 40.8128, lon: -74.0742, indoor: false },
  PHI: { lat: 39.9008, lon: -75.1675, indoor: false },
  PIT: { lat: 40.4468, lon: -80.0158, indoor: false },
  SEA: { lat: 47.5952, lon: -122.3316, indoor: false },
  SF: { lat: 37.403, lon: -121.97, indoor: false },
  TB: { lat: 27.9759, lon: -82.5033, indoor: false },
  TEN: { lat: 36.1665, lon: -86.7713, indoor: false },
  WAS: { lat: 38.9077, lon: -76.8645, indoor: false },
};

const cache = new Map<string, WeatherSummary>();

function indoorSummary(roof: string | null | undefined): WeatherSummary {
  const r = (roof || "").toLowerCase();
  if (r.includes("retractable")) return { emoji: "🏟️", label: "Retractable roof" };
  if (r.includes("dome") || r.includes("closed") || r.includes("indoor")) {
    return { emoji: "🏟️", label: "Dome / indoor" };
  }
  return { emoji: "🏟️", label: "Indoor stadium" };
}

function fromObserved(temp: number | null | undefined, wind: number | null | undefined, roof: string | null | undefined): WeatherSummary | null {
  if (temp == null && wind == null) return null;
  const t = temp != null ? `${Math.round(temp)}°F` : null;
  const w = wind != null && wind > 0 ? `Wind ${Math.round(wind)} mph` : null;
  const outdoor = !(roof || "").toLowerCase().match(/dome|closed|indoor|retractable/);
  const emoji = outdoor ? emojiFromTempWind(temp ?? 70, wind ?? 0, 0) : "🏟️";
  return { emoji, label: [t, w].filter(Boolean).join(" · ") || "Weather listed" };
}

/** WMO weather interpretation codes → emoji + short label. */
function fromWmo(code: number, tempF: number, windMph: number): WeatherSummary {
  const emoji = emojiFromCode(code, tempF, windMph);
  const sky = labelFromCode(code);
  const bits = [`${Math.round(tempF)}°F`, sky];
  if (windMph >= 12) bits.push(`Wind ${Math.round(windMph)} mph`);
  return { emoji, label: bits.join(" · ") };
}

function emojiFromTempWind(tempF: number, windMph: number, precipIn: number): string {
  if (precipIn >= 0.2) return tempF <= 34 ? "🌨️" : "🌧️";
  if (windMph >= 20) return "💨";
  if (tempF <= 32) return "🥶";
  if (tempF >= 88) return "🥵";
  return "☀️";
}

function emojiFromCode(code: number, tempF: number, windMph: number): string {
  if (code === 0) return tempF >= 85 ? "☀️" : "🌤️";
  if (code <= 2) return "⛅";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 51 && code <= 67) return "🌧️";
  if (code >= 71 && code <= 77) return "🌨️";
  if (code >= 80 && code <= 82) return "🌦️";
  if (code >= 85 && code <= 86) return "🌨️";
  if (code >= 95) return "⛈️";
  if (windMph >= 20) return "💨";
  return "🌤️";
}

function labelFromCode(code: number): string {
  if (code === 0) return "Clear";
  if (code === 1) return "Mostly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 55) return "Drizzle";
  if (code >= 56 && code <= 57) return "Freezing drizzle";
  if (code >= 61 && code <= 65) return "Rain";
  if (code >= 66 && code <= 67) return "Freezing rain";
  if (code >= 71 && code <= 75) return "Snow";
  if (code === 77) return "Snow grains";
  if (code >= 80 && code <= 82) return "Showers";
  if (code >= 85 && code <= 86) return "Snow showers";
  if (code === 95) return "Thunderstorms";
  if (code >= 96) return "Storms with hail";
  return "Mixed";
}

function isIndoor(homeTeam: string, roof: string | null | undefined): boolean {
  const r = (roof || "").toLowerCase();
  if (r.includes("dome") || r.includes("closed") || r.includes("indoor")) return true;
  if (r.includes("retractable")) return true;
  if (r.includes("outdoors") || r.includes("open")) return false;
  return STADIUMS[homeTeam]?.indoor ?? false;
}

/**
 * Resolve expected conditions for a game. Uses schedule temp/wind when present;
 * otherwise forecasts outdoor kickoffs via Open-Meteo.
 */
export async function expectedWeather(input: {
  gameId: string;
  homeTeam: string;
  gameday: string;
  roof?: string | null;
  temp?: number | null;
  wind?: number | null;
  signal?: AbortSignal;
}): Promise<WeatherSummary> {
  const hit = cache.get(input.gameId);
  if (hit) return hit;

  if (isIndoor(input.homeTeam, input.roof)) {
    const summary = indoorSummary(input.roof);
    cache.set(input.gameId, summary);
    return summary;
  }

  const observed = fromObserved(input.temp, input.wind, input.roof);
  if (observed) {
    cache.set(input.gameId, observed);
    return observed;
  }

  const stadium = STADIUMS[input.homeTeam];
  if (!stadium) {
    const fallback = { emoji: "🌤️", label: "Outdoor · forecast unavailable" };
    cache.set(input.gameId, fallback);
    return fallback;
  }

  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${stadium.lat}&longitude=${stadium.lon}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
    `&timezone=America/New_York&start_date=${input.gameday}&end_date=${input.gameday}`;

  try {
    const res = await fetch(url, { signal: input.signal });
    if (!res.ok) throw new Error(`weather HTTP ${res.status}`);
    const data = (await res.json()) as {
      daily?: {
        weather_code?: number[];
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        precipitation_sum?: number[];
        wind_speed_10m_max?: number[];
      };
    };
    const d = data.daily;
    const code = d?.weather_code?.[0] ?? 1;
    const hi = d?.temperature_2m_max?.[0];
    const lo = d?.temperature_2m_min?.[0];
    const temp = hi != null && lo != null ? (hi + lo) / 2 : hi ?? lo ?? 70;
    const wind = d?.wind_speed_10m_max?.[0] ?? 0;
    const summary = fromWmo(code, temp, wind);
    // Prefer a high/low style label when both exist.
    if (hi != null && lo != null) {
      summary.label = `${Math.round(lo)}–${Math.round(hi)}°F · ${labelFromCode(code)}` +
        (wind >= 12 ? ` · Wind ${Math.round(wind)} mph` : "");
    }
    cache.set(input.gameId, summary);
    return summary;
  } catch {
    const fallback = { emoji: "🌤️", label: "Outdoor · forecast pending" };
    // Don't cache hard failures forever if aborted.
    if (!input.signal?.aborted) cache.set(input.gameId, fallback);
    return fallback;
  }
}

// silence unused helper warning in some builds
