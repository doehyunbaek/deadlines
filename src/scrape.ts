import * as fs from "fs";
import { parse } from "node-html-parser";
import { decode } from "html-entities";

//
// ─── 1) TYPES ───────────────────────────────────────────────────────────────────
//

// RawSubmission: exactly one row’s worth of DOM data, no AoE or grouping here.
export interface RawSubmission {
  trackUrl: URL;         // the absolute <a href="…">
  linkText: string;      // the anchor’s text (e.g. "ICSE 2026 Research Track")
  millis: number;        // Number(span.textContent) from the DOM
  type: string;          // the “small” inside span.pull-right
  location: string;      // raw text from the 3rd <td>
}

// After grouping/processing:
export interface Deadline {
  type: string;          // “Abstract”, “Full Paper”, etc.
  date: string;          // AoE “YYYY-MM-DD 23:59”
}

export interface Track {
  name: string;          // “Research Track”, etc.
  url: URL;
  deadlines: Deadline[];
}

export interface Edition {
  year: number;          // e.g. 2026
  location: string;      // e.g. “Rio de Janeiro, Brazil”
  tracks: Track[];
}

export interface Conference {
  conference: string;    // e.g. “ICSE”
  editions: Edition[];
}

//
// ─── 2) HELPER: parse conf+year from a URL or link text ────────────────────────
//

const KNOWN_CONFS = [
  "icse", "icsme", "esem", "fse", "saner", "models", "issta",
  "popl", "icfp", "splash", "pldi", "aplas", "cisose", "dx",
  "ecoop", "icooolps", "ecsa", "icer", "haskell", "fproper", "funarch",
  "mlsymposium", "tyde", "acsos", "apsec", "gcm", "ase",
];

/**
 * Given a track URL (and optionally linkText), return:
 *  - conference code (e.g. “ICSE”) or “OTHER” if none matches
 *  - year (as number) or NaN if not found
 */
function parseConfAndYear(
  trackUrl: URL,
  linkText?: string
): { conference: string; year: number } {
  const hrefLower = trackUrl.href.toLowerCase();

  // 1) Try “-YYYY” in the pathname
  const pathMatch = trackUrl.pathname.match(/-(\d{4})(?:\/|$)/);
  if (pathMatch) {
    let conference = "OTHER";
    for (const key of KNOWN_CONFS) {
      const re = new RegExp(`(^|[^a-z])${key}([^a-z]|$)`);
      if (re.test(hrefLower)) {
        conference = key.toUpperCase();
        break;
      }
    }
    return { conference, year: Number(pathMatch[1]) };
  }

  // 2) Fallback: “YYYY” in the hostname
  const hostMatch = trackUrl.hostname.match(/(\d{4})/);
  if (hostMatch) {
    let conference = "OTHER";
    const hostLower = trackUrl.hostname.toLowerCase();
    for (const key of KNOWN_CONFS) {
      if (hostLower.includes(key)) {
        conference = key.toUpperCase();
        break;
      }
    }
    return { conference, year: Number(hostMatch[1]) };
  }

  // 3) Final fallback: split linkText (“ICSE 2026 Research Track” → [“ICSE”, “2026”, …])
  if (linkText) {
    const tokens = linkText.trim().split(/\s+/);
    if (tokens.length >= 2) {
      const maybeYear = Number(tokens[1]);
      if (!Number.isNaN(maybeYear)) {
        const conference = tokens[0].toUpperCase();
        return { conference, year: maybeYear };
      }
    }
  }

  return { conference: "OTHER", year: NaN };
}

//
// ─── 3) FETCH RAW SUBMISSIONS (no AoE, no grouping) ────────────────────────────
//

/**
 * Scrape a Researchr “submissiondates” page and return RawSubmission[] exactly as extracted.
 */
export async function fetchConferences(url: string): Promise<RawSubmission[]> {
  const baseUrl = new URL(url);
  const res = await fetch(baseUrl);
  const html = await res.text();
  const root = parse(html);

  const table = root.querySelector("table");
  if (!table) throw new Error("Table not found on " + url);

  // Skip the first two header rows (assume first two <tr> are headings)
  const rows = table.querySelectorAll("tr").slice(2);
  const rawSubs: RawSubmission[] = [];

  for (const row of rows) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 3) continue;

    // 1) Extract the timestamp <span>
    const span = cells[0].querySelector("span");
    const millis = Number(span?.textContent.trim() || "");
    if (!millis) continue; // skip rows without a valid timestamp

    // 2) Extract <a> for the track
    const a = cells[1].querySelector("a");
    if (!a) continue;
    const href = a.getAttribute("href") || "";
    const trackUrl = new URL(href, baseUrl);
    const linkText = a.textContent.trim();

    // 3) Extract “type” from <span.pull-right><small>…</small></span>
    const type =
      cells[1].querySelector("span.pull-right small")?.textContent.trim() || "";

    // 4) Extract raw location
    const location = cells[2].textContent.trim();

    rawSubs.push({
      trackUrl,
      linkText,
      millis,
      type,
      location,
    });
  }

  return rawSubs;
}

//
// ─── 4) CONVERT rawSubs → Conference[] (AoE conversion + grouping) ─────────────
//

/**
 * Convert a UNIX‐millisecond timestamp into an AoE (“UTC−12”) “YYYY-MM-DD 23:59” string.
 */
function millisToAoEDate(millis: number): string {
  const d = new Date(millis);
  const AOE_OFFSET = 12 * 60 * 60 * 1000; // 12h in ms
  const aoeMillis = d.getTime() - AOE_OFFSET;
  const aoeDate = new Date(aoeMillis);

  const YYYY = aoeDate.getUTCFullYear();
  const MM   = String(aoeDate.getUTCMonth() + 1).padStart(2, "0");
  const DD   = String(aoeDate.getUTCDate()).padStart(2, "0");
  return `${YYYY}-${MM}-${DD} 23:59`;
}

/**
 * Take an array of RawSubmission and build a grouped Conference[].
 */
export function buildConferences(rawSubs: RawSubmission[]): Conference[] {
  type EditionMap = Map<number, Edition>;
  const confMap = new Map<string, EditionMap>();

  for (const sub of rawSubs) {
    // (1) Determine conference code + year
    const { conference: confCode, year } = parseConfAndYear(
      sub.trackUrl,
      sub.linkText
    );
    if (!confCode || isNaN(year)) {
      continue;
    }

    // (2) Convert millis → AoE deadline string
    const aoeString = millisToAoEDate(sub.millis);

    // (3) Derive trackName by stripping “CONF YEAR ” prefix from linkText if present
    const prefix = `${confCode} ${year} `;
    const trackName = sub.linkText.startsWith(prefix)
      ? sub.linkText.slice(prefix.length)
      : sub.linkText;

    // (4) Build a Deadline object
    const deadline: Deadline = { type: sub.type, date: aoeString };

    // (5) Insert into grouping map
    let yearMap = confMap.get(confCode);
    if (!yearMap) {
      yearMap = new Map<number, Edition>();
      confMap.set(confCode, yearMap);
    }

    let edition = yearMap.get(year);
    if (!edition) {
      edition = { year, location: sub.location, tracks: [] };
      yearMap.set(year, edition);
    }

    // (6) Find or create the Track in this edition
    let trackObj = edition.tracks.find(
      (t) => t.name === trackName && t.url.href === sub.trackUrl.href
    );
    if (!trackObj) {
      trackObj = { name: trackName, url: sub.trackUrl, deadlines: [] };
      edition.tracks.push(trackObj);
    }

    // (7) Append this deadline
    trackObj.deadlines.push(deadline);
  }

  // (8) Flatten into Conference[]
  const result: Conference[] = [];
  for (const [confCode, yearMap] of confMap) {
    const editions = Array.from(yearMap.values()).sort((a, b) => a.year - b.year);
    result.push({ conference: confCode, editions });
  }
  return result;
}

/**
 * (Optional) Filter each Conference to keep only the “main research/technical track”.
 */
export function filterTracks(confs: Conference[]): Conference[] {
  function isMainResearchTrack(trackName: string) {
    const lower = trackName.toLowerCase().trim();
    if (/research\s*track/.test(lower)) return true;
    if (/technical\s*(track|papers?)/.test(lower)) return true;
    if (/research\s*papers?/.test(lower)) return true;
    return false;
  }

  for (const conf of confs) {
    for (const ed of conf.editions) {
      const main = ed.tracks.find((t) => isMainResearchTrack(t.name));
      ed.tracks = main ? [main] : [];
    }
  }
  return confs;
}

//
// ─── 5) HIGHER-LEVEL: FETCH MULTIPLE YEARS + WRITE JSON FILES ────────────────
//

/**
 * Fetch raw submissions for each year, flatten, then:
 *  1) Write rawsubs.json = RawSubmission[]
 *  2) Build the grouped Conference[]
 *  3) Write conferences.json = array of Jekyll entries
 *  4) Write settings.json = { use_raw: boolean }
 */
async function createICS() {
  // 1) Build URLs for each year
  const startYear = 2011;
  const endYear   = 2025;
  const urls = Array.from(
    { length: endYear - startYear + 1 },
    (_, i) => {
      const year = startYear + i;
      return `https://conf.researchr.org/submissiondates/v%3D${year}%26fn%3Dyear%26cnt%3D500%26sel%3Dtrue%26occ%3DSHOULD%26`;
    }
  );

  // 2) Fetch raw submissions in parallel
  const perYearRaw: RawSubmission[][] = await Promise.all(
    urls.map((url) => fetchConferences(url))
  );
  // 3) Flatten into one big array
  const allRaw: RawSubmission[] = perYearRaw.flat();

  // 4) Ensure the _data directory exists
  const dataDir = "/Users/doehyunbaek/Desktop/deadlines/_data";
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // 5) Write rawsubs.json
  const rawPath = `${dataDir}/rawsubs.json`;
  fs.writeFileSync(rawPath, JSON.stringify(allRaw, null, 2), "utf8");
  console.log(`Wrote ${allRaw.length} raw submissions to ${rawPath}`);

  // 6) Build grouped Conference[] from raw
  const grouped = buildConferences(allRaw);

  // 7) (Optional) Keep only ICSE & main research track, if you choose
  let icseOnly = grouped.filter((c) => c.conference === "ICSE");
  icseOnly = filterTracks(icseOnly);

  // 8) Transform into Jekyll meta‐structure
  interface JekyllEntry {
    name: string;
    description: string;
    year: number;
    link: string;
    deadline: string[];
    place: string;
    // you can add `date` or `note` if needed
  }

  const jekyllEntries: JekyllEntry[] = [];
  for (const confObj of icseOnly) {
    for (const ed of confObj.editions) {
      for (const track of ed.tracks) {
        jekyllEntries.push({
          name: confObj.conference, // “ICSE”
          description: `International Conference on Software Engineering - ${track.name}`,
          year: ed.year,
          link: track.url.toString(),
          deadline: track.deadlines.map((dl) => dl.date),
          place: ed.location,
        });
      }
    }
  }

  // 9) Write conferences.json
  const confPath = `${dataDir}/conferences.json`;
  fs.writeFileSync(confPath, JSON.stringify(jekyllEntries, null, 2), "utf8");
  console.log(`Wrote ${jekyllEntries.length} Jekyll entries to ${confPath}`);

  // 10) Write a tiny settings.json so your UI can “toggle” between raw vs processed
  const settings = {
    // If true, your front‐end should load rawsubs.json instead of conferences.json
    use_raw: false,
  };
  const settingsPath = `${dataDir}/settings.json`;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  console.log(`Wrote settings to ${settingsPath}`);
}

createICS().catch(console.error);
