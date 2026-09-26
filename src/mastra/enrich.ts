/**
 * Threat-intel enrichment. Every lookup degrades gracefully (PRD FR4): a
 * missing key or a failed request is recorded as a warning on the event and
 * never throws, so the pipeline keeps running.
 */

export type GeoResult = {
  country?: string;
  city?: string;
  asnOrg?: string;
};

/** Retry with exponential backoff on 429/5xx. Free tiers need this (Step 5). */
async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  attempts = 3,
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) {
        // Retry-After wins when present, else exponential backoff.
        const ra = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2 ** i * 500;
        if (i < attempts - 1) {
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1)
        await new Promise((r) => setTimeout(r, 2 ** i * 500));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Geolocation + ASN via ip-api.com (free, no key). Private/reserved IPs are
 * skipped rather than queried.
 */
export async function lookupGeo(ip: string): Promise<{
  geo?: GeoResult;
  warnings: string[];
}> {
  const warnings: string[] = [];
  if (
    ip === "127.0.0.1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("172.16.") ||
    ip === "::1"
  ) {
    return { warnings: ["skipped geo lookup for private IP"] };
  }
  try {
    const res = await fetchWithRetry(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,city,isp,as`,
    );
    const data = (await res.json()) as {
      status?: string;
      country?: string;
      city?: string;
      isp?: string;
      as?: string;
    };
    if (data.status !== "success") {
      return {
        warnings: [`geo lookup returned status=${data.status ?? "unknown"}`],
      };
    }
    return {
      geo: {
        country: data.country,
        city: data.city,
        asnOrg: [data.as, data.isp].filter(Boolean).join(" — ") || undefined,
      },
      warnings,
    };
  } catch (err) {
    warnings.push(`geo lookup failed: ${(err as Error).message}`);
    return { warnings };
  }
}

/** AbuseIPDB reputation. Optional — silently skipped when no key is set. */
export async function lookupReputation(ip: string): Promise<{
  reputationScore?: number;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const key = process.env.ABUSEIPDB_API_KEY;
  if (!key) {
    warnings.push("AbuseIPDB skipped: ABUSEIPDB_API_KEY not set");
    return { warnings };
  }
  try {
    const res = await fetchWithRetry(
      `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`,
      { headers: { key, Accept: "application/json" } },
    );
    if (!res.ok) {
      warnings.push(`AbuseIPDB returned HTTP ${res.status}`);
      return { warnings };
    }
    const data = (await res.json()) as {
      data?: { abuseConfidenceScore?: number };
    };
    return { reputationScore: data.data?.abuseConfidenceScore, warnings };
  } catch (err) {
    warnings.push(`AbuseIPDB failed: ${(err as Error).message}`);
    return { warnings };
  }
}

/** Combine both lookups; never throws (FR4). */
export async function enrich(ip: string): Promise<{
  geo?: GeoResult;
  reputationScore?: number;
  warnings: string[];
}> {
  const [g, r] = await Promise.all([lookupGeo(ip), lookupReputation(ip)]);
  return {
    geo: g.geo,
    reputationScore: r.reputationScore,
    warnings: [...g.warnings, ...r.warnings],
  };
}
