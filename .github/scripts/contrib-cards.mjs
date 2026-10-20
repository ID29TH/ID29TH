// Builds profile/streak.svg and profile/activity.svg from the GitHub
// contribution calendar, so the README does not depend on the public
// streak-stats / activity-graph endpoints.
//
// Usage: GITHUB_TOKEN=... node contrib-cards.mjs <login> <out-dir>
//        node contrib-cards.mjs --sample <out-dir>   (renders fake data)

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const THEME = {
  bg: "#000000",
  border: "#21262d",
  title: "#ffffff",
  text: "#c9d1d9",
  muted: "#8b949e",
  grid: "#1c1f24",
  accent: "#ffffff",
};

const FONT = "'Segoe UI', Ubuntu, 'Helvetica Neue', Sans-Serif";
const GRAPH_DAYS = 31;

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`GraphQL ${res.status}: ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data;
}

const CALENDAR = `
  query ($login: String!, $from: DateTime, $to: DateTime) {
    user(login: $login) {
      name
      contributionsCollection(from: $from, to: $to) {
        contributionYears
        contributionCalendar {
          weeks { contributionDays { date contributionCount } }
        }
      }
    }
  }`;

// Returns every calendar day from the first contribution year until today,
// oldest first, as [{ date: "YYYY-MM-DD", count }].
async function fetchDays(login) {
  const now = new Date();
  const first = await graphql(CALENDAR, { login });
  if (!first.user) throw new Error(`User ${login} not found`);
  const years = [...first.user.contributionsCollection.contributionYears].sort();

  const days = new Map();
  for (const year of years) {
    const from = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
    const to = end < now ? end : now;
    const data = await graphql(CALENDAR, {
      login,
      from: from.toISOString(),
      to: to.toISOString(),
    });
    for (const week of data.user.contributionsCollection.contributionCalendar.weeks) {
      for (const d of week.contributionDays) days.set(d.date, d.contributionCount);
    }
  }
  const today = now.toISOString().slice(0, 10);
  return {
    name: first.user.name || login,
    days: [...days]
      .filter(([date]) => date <= today)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count })),
  };
}

function sampleDays() {
  const days = [];
  const today = new Date();
  for (let i = 700; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 864e5);
    const wave = Math.max(0, Math.round(6 * Math.sin(i / 9) + 4 * Math.random() - (i % 13 === 0 ? 9 : 0)));
    days.push({ date: d.toISOString().slice(0, 10), count: i < 5 ? 3 + i : wave });
  }
  return { name: "Sample", days };
}

function computeStats(days) {
  const total = days.reduce((sum, d) => sum + d.count, 0);
  const firstActive = days.find((d) => d.count > 0);

  let longest = { length: 0, start: null, end: null };
  let run = { length: 0, start: null, end: null };
  for (const d of days) {
    if (d.count > 0) {
      run = { length: run.length + 1, start: run.length ? run.start : d.date, end: d.date };
      if (run.length > longest.length) longest = { ...run };
    } else {
      run = { length: 0, start: null, end: null };
    }
  }

  // A day without contributions yet does not break the current streak.
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i--;
  const current = { length: 0, start: null, end: i >= 0 ? days[i].date : null };
  for (; i >= 0 && days[i].count > 0; i--) {
    current.length++;
    current.start = days[i].date;
  }

  return { total, since: firstActive?.date ?? null, current, longest };
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function fmtDate(iso, withYear = true) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

function fmtRange(r) {
  if (!r.length) return "No streak yet";
  const sameYear = r.start.slice(0, 4) === r.end.slice(0, 4);
  const thisYear = r.end.slice(0, 4) === new Date().toISOString().slice(0, 4);
  if (r.start === r.end) return fmtDate(r.start, !thisYear);
  return `${fmtDate(r.start, !(sameYear && thisYear))} - ${fmtDate(r.end, !thisYear)}`;
}

function frame(width, height, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">
  <title>${esc(title)}</title>
  <style>
    text { font-family: ${FONT}; }
    .fade { opacity: 0; animation: fade .6s ease-in-out forwards; }
    @keyframes fade { to { opacity: 1; } }
  </style>
  <rect x="0.5" y="0.5" rx="10" width="${width - 1}" height="${height - 1}" fill="${THEME.bg}" stroke="${THEME.border}"/>
${body}
</svg>
`;
}

function renderStreak(stats) {
  const W = 495;
  const H = 195;
  const col = W / 3;
  const num = (n) => n.toLocaleString("en-US");
  const since = stats.since ? `${fmtDate(stats.since)} - Present` : "";

  const side = (x, value, label, sub, delay) => `
  <g class="fade" style="animation-delay:${delay}ms" transform="translate(${x}, 0)">
    <text x="0" y="88" text-anchor="middle" fill="${THEME.title}" font-size="28" font-weight="700">${value}</text>
    <text x="0" y="122" text-anchor="middle" fill="${THEME.text}" font-size="14">${esc(label)}</text>
    <text x="0" y="146" text-anchor="middle" fill="${THEME.muted}" font-size="12">${esc(sub)}</text>
  </g>`;

  const cx = col * 1.5;
  const body = `
  <line x1="${col}" y1="28" x2="${col}" y2="167" stroke="${THEME.border}"/>
  <line x1="${col * 2}" y1="28" x2="${col * 2}" y2="167" stroke="${THEME.border}"/>
${side(col / 2, num(stats.total), "Total Contributions", since, 100)}
  <g class="fade" style="animation-delay:300ms">
    <circle cx="${cx}" cy="71" r="40" fill="none" stroke="${THEME.accent}" stroke-width="5"/>
    <rect x="${cx - 13}" y="21" width="26" height="26" fill="${THEME.bg}"/>
    <path transform="translate(${cx - 10}, 22) scale(0.85)" fill="${THEME.accent}" d="M12 1.5c.6 3-1 4.8-2.6 6.6C7.9 9.8 6.3 11.6 6.3 14.6c0 3.3 2.6 6 5.7 6s5.7-2.7 5.7-6c0-2.1-.9-3.7-2-5.1-.2 1.3-.8 2.3-1.8 2.9.4-2.9-.4-6.6-1.9-10.9Z"/>
    <text x="${cx}" y="81" text-anchor="middle" fill="${THEME.title}" font-size="28" font-weight="700">${num(stats.current.length)}</text>
    <text x="${cx}" y="134" text-anchor="middle" fill="${THEME.title}" font-size="14" font-weight="700">Current Streak</text>
    <text x="${cx}" y="158" text-anchor="middle" fill="${THEME.muted}" font-size="12">${esc(fmtRange(stats.current))}</text>
  </g>
${side(col * 2.5, num(stats.longest.length), "Longest Streak", fmtRange(stats.longest), 500)}`;

  return frame(W, H, `Contribution streak: ${stats.current.length} days current, ${stats.longest.length} days longest`, body);
}

// Catmull-Rom spline through the points, as cubic Bezier segments.
function smoothPath(pts) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1.map((v) => v.toFixed(1))} ${c2.map((v) => v.toFixed(1))} ${p2.map((v) => v.toFixed(1))}`;
  }
  return d;
}

function niceMax(n) {
  if (n <= 4) return 4;
  const step = Math.pow(10, Math.floor(Math.log10(n)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= n) return m * step;
  return 10 * step;
}

function renderActivity(name, days) {
  const W = 850;
  const H = 300;
  const pad = { top: 56, right: 30, bottom: 50, left: 55 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const recent = days.slice(-GRAPH_DAYS);
  const max = niceMax(Math.max(...recent.map((d) => d.count)));
  const y = (v) => pad.top + plotH - (v / max) * plotH;
  const x = (i) => pad.left + (recent.length === 1 ? plotW / 2 : (i / (recent.length - 1)) * plotW);
  const pts = recent.map((d, i) => [x(i), y(d.count)]);
  const line = smoothPath(pts);
  const base = pad.top + plotH;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const grid = ticks
    .map(
      (t) => `    <line x1="${pad.left}" y1="${y(t)}" x2="${W - pad.right}" y2="${y(t)}" stroke="${THEME.grid}"/>
    <text x="${pad.left - 10}" y="${y(t) + 4}" text-anchor="end" fill="${THEME.muted}" font-size="11">${Number.isInteger(t) ? t : t.toFixed(1)}</text>`,
    )
    .join("\n");
  const xLabels = recent
    .map((d, i) => `    <text x="${x(i)}" y="${base + 20}" text-anchor="middle" fill="${THEME.muted}" font-size="11">${Number(d.date.slice(8))}</text>`)
    .join("\n");
  const dots = pts
    .map(([px, py], i) => `    <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3" fill="${THEME.bg}" stroke="${THEME.accent}" stroke-width="1.5"><title>${esc(`${fmtDate(recent[i].date)}: ${recent[i].count}`)}</title></circle>`)
    .join("\n");

  const range = recent.length ? `${fmtDate(recent[0].date)} - ${fmtDate(recent.at(-1).date)}` : "";
  const body = `
  <defs>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${THEME.accent}" stop-opacity="0.22"/>
      <stop offset="1" stop-color="${THEME.accent}" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="plot"><rect x="${pad.left}" y="${pad.top - 6}" width="${plotW}" height="${plotH + 6}"/></clipPath>
  </defs>
  <text x="${W / 2}" y="32" text-anchor="middle" fill="${THEME.title}" font-size="16" font-weight="600">${esc(name)}'s Contribution Graph</text>
  <text x="${W - pad.right}" y="32" text-anchor="end" fill="${THEME.muted}" font-size="11">${esc(range)}</text>
  <g>
${grid}
${xLabels}
  </g>
  <text x="${W / 2}" y="${H - 10}" text-anchor="middle" fill="${THEME.muted}" font-size="11">Days</text>
  <text transform="translate(16, ${pad.top + plotH / 2}) rotate(-90)" text-anchor="middle" fill="${THEME.muted}" font-size="11">Contributions</text>
  <g class="fade" style="animation-delay:150ms" clip-path="url(#plot)">
    <path d="${line} L${x(recent.length - 1)},${base} L${x(0)},${base} Z" fill="url(#area)"/>
    <path d="${line}" fill="none" stroke="${THEME.accent}" stroke-width="2.2" stroke-linejoin="round"/>
  </g>
  <g class="fade" style="animation-delay:350ms">
${dots}
  </g>`;

  return frame(W, H, `${name}'s contributions over the last ${recent.length} days`, body);
}

async function main() {
  const args = process.argv.slice(2);
  const sample = args[0] === "--sample";
  const outDir = args[1];
  if (!outDir || (!sample && !args[0])) {
    console.error("Usage: node contrib-cards.mjs <login> <out-dir> | --sample <out-dir>");
    process.exit(2);
  }
  if (!sample && !process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set");

  const { name, days } = sample ? sampleDays() : await fetchDays(args[0]);
  if (!days.length) throw new Error("No contribution days returned");
  const stats = computeStats(days);

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "streak.svg"), renderStreak(stats));
  await writeFile(join(outDir, "activity.svg"), renderActivity(name, days));
  console.log(
    `total=${stats.total} current=${stats.current.length} longest=${stats.longest.length} since=${stats.since}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
