// Draws the black and white cards in profile/: streak, contribution graph,
// top languages, WakaTime and the pinned repo.
//
// Usage: GITHUB_TOKEN=... node profile-cards.mjs --login <user> --out <dir>
//          [--wakatime <user>] [--pin <owner/repo>]
//        node profile-cards.mjs --sample --out <dir>   (renders fake data)
//
// If one card fails (WakaTime down, etc.) its old file is kept and the rest
// still update.

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
const TOP_LANGS = 6;

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

const LANGUAGES = `
  query ($login: String!, $after: String) {
    user(login: $login) {
      repositories(ownerAffiliations: OWNER, isFork: false, first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { name } }
          }
        }
      }
    }
  }`;

// Bytes of code per language across the user's own non-fork repositories,
// as [{ name, percent }] sorted by size.
async function fetchLanguages(login) {
  const bytes = new Map();
  let after = null;
  do {
    const data = await graphql(LANGUAGES, { login, after });
    const repos = data.user.repositories;
    for (const repo of repos.nodes) {
      for (const { size, node } of repo.languages.edges) {
        bytes.set(node.name, (bytes.get(node.name) ?? 0) + size);
      }
    }
    after = repos.pageInfo.hasNextPage ? repos.pageInfo.endCursor : null;
  } while (after);
  const total = [...bytes.values()].reduce((a, b) => a + b, 0);
  return [...bytes]
    .sort(([, a], [, b]) => b - a)
    .map(([name, size]) => ({ name, percent: (size / total) * 100 }));
}

const REPO = `
  query ($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      nameWithOwner
      description
      stargazerCount
      forkCount
      primaryLanguage { name }
    }
  }`;

async function fetchRepo(slug) {
  const [owner, name] = slug.split("/");
  const data = await graphql(REPO, { owner, name });
  if (!data.repository) throw new Error(`Repository ${slug} not found`);
  return data.repository;
}

// Last 7 days of WakaTime languages, as [{ name, percent, text }].
async function fetchWakatime(user) {
  const res = await fetch(`https://wakatime.com/api/v1/users/${encodeURIComponent(user)}/stats/last_7_days`);
  if (!res.ok) throw new Error(`WakaTime ${res.status}: ${await res.text()}`);
  const { data } = await res.json();
  if (!data.is_language_usage_visible || !Array.isArray(data.languages)) {
    throw new Error("WakaTime language stats are not public");
  }
  return {
    total: data.human_readable_total_including_other_language,
    languages: data.languages.map((l) => ({ name: l.name, percent: l.percent, text: l.text })),
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

const SAMPLE_LANGUAGES = [
  { name: "JavaScript", percent: 52.4 },
  { name: "CSS", percent: 21.7 },
  { name: "HTML", percent: 14.1 },
  { name: "TypeScript", percent: 7.3 },
  { name: "Shell", percent: 3.2 },
  { name: "Dockerfile", percent: 1.3 },
];

const SAMPLE_WAKATIME = {
  total: "12 hrs 41 mins",
  languages: [
    { name: "JavaScript", percent: 61.2, text: "7 hrs 46 mins" },
    { name: "CSS", percent: 18.9, text: "2 hrs 24 mins" },
    { name: "HTML", percent: 11.4, text: "1 hr 27 mins" },
    { name: "JSON", percent: 8.5, text: "1 hr 4 mins" },
  ],
};

const SAMPLE_REPO = {
  nameWithOwner: "sample-org/sample-repo",
  description: "A sample repository whose description is long enough to wrap onto a second line of the card.",
  stargazerCount: 12,
  forkCount: 3,
  primaryLanguage: { name: "JavaScript" },
};

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

// Word-wraps text into at most maxLines lines of maxChars characters.
function wrap(text, maxChars, maxLines) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, maxChars - 1)}…`;
  }
  return lines;
}

// One row per language: name, a white bar on a dark track, and a value.
function barRows(rows, { x, y, width, nameWidth, valueWidth, step = 30 }) {
  const track = width - nameWidth - valueWidth;
  return rows
    .map((r, i) => {
      const ry = y + i * step;
      const fill = Math.max(2, (r.percent / 100) * track);
      return `  <g class="fade" style="animation-delay:${150 + i * 120}ms" transform="translate(${x}, ${ry})">
    <text x="0" y="12" fill="${THEME.text}" font-size="13" font-weight="600">${esc(r.name)}</text>
    <rect x="${nameWidth}" y="3" width="${track}" height="8" rx="4" fill="${THEME.grid}"/>
    <rect x="${nameWidth}" y="3" width="${fill.toFixed(1)}" height="8" rx="4" fill="${THEME.accent}"/>
    <text x="${width}" y="12" text-anchor="end" fill="${THEME.muted}" font-size="12">${esc(r.value)}</text>
  </g>`;
    })
    .join("\n");
}

function renderLanguages(langs) {
  // Same height as the stats card, which sits beside it.
  const W = 400;
  const H = 195;
  const rows = langs.slice(0, TOP_LANGS).map((l) => ({ ...l, value: `${l.percent.toFixed(1)}%` }));
  const body = `
  <text x="25" y="38" fill="${THEME.title}" font-size="18" font-weight="600">Most Used Languages</text>
${rows.length ? barRows(rows, { x: 25, y: 56, width: W - 50, nameWidth: 105, valueWidth: 60, step: 22 }) : `  <text x="25" y="72" fill="${THEME.muted}" font-size="13">No code yet</text>`}`;
  return frame(W, H, `Most used languages: ${rows.map((r) => `${r.name} ${r.value}`).join(", ")}`, body);
}

function renderWakatime(stats) {
  const W = 495;
  const rows = stats.languages.slice(0, TOP_LANGS).map((l) => ({ ...l, value: l.text }));
  const H = 70 + Math.max(rows.length, 1) * 30;
  const body = `
  <text x="25" y="38" fill="${THEME.title}" font-size="18" font-weight="600">Coding time</text>
  <text x="${W - 25}" y="38" text-anchor="end" fill="${THEME.muted}" font-size="13">Total ${esc(stats.total || "0 secs")}</text>
${rows.length ? barRows(rows, { x: 25, y: 60, width: W - 50, nameWidth: 120, valueWidth: 110 }) : `  <text x="25" y="72" fill="${THEME.muted}" font-size="13">No coding activity in the last 7 days</text>`}`;
  return frame(W, H, `WakaTime, last 7 days: ${rows.map((r) => `${r.name} ${r.value}`).join(", ") || "no activity"}`, body);
}

const ICONS = {
  repo: "M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z",
  star: "M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Zm0 2.445L6.615 5.5a.75.75 0 0 1-.564.41l-3.097.45 2.24 2.184a.75.75 0 0 1 .216.664l-.528 3.084 2.769-1.456a.75.75 0 0 1 .698 0l2.77 1.456-.53-3.084a.75.75 0 0 1 .216-.664l2.24-2.183-3.096-.45a.75.75 0 0 1-.564-.41L8 2.694Z",
  fork: "M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z",
};

function renderRepo(repo) {
  const W = 400;
  const H = 125;
  const desc = wrap(repo.description || "No description provided", 52, 2);
  const meta = [];
  let mx = 25;
  if (repo.primaryLanguage) {
    meta.push(`<circle cx="${mx + 6}" cy="-4" r="6" fill="none" stroke="${THEME.accent}" stroke-width="2"/>
    <text x="${mx + 18}" y="0" fill="${THEME.text}" font-size="12">${esc(repo.primaryLanguage.name)}</text>`);
    mx += 30 + repo.primaryLanguage.name.length * 7;
  }
  for (const [icon, count] of [["star", repo.stargazerCount], ["fork", repo.forkCount]]) {
    meta.push(`<path transform="translate(${mx}, -12)" fill="${THEME.text}" d="${ICONS[icon]}"/>
    <text x="${mx + 22}" y="0" fill="${THEME.text}" font-size="12">${count.toLocaleString("en-US")}</text>`);
    mx += 30 + String(count).length * 8;
  }
  const body = `
  <g class="fade">
    <path transform="translate(25, 22)" fill="${THEME.accent}" d="${ICONS.repo}"/>
    <text x="50" y="35" fill="${THEME.title}" font-size="16" font-weight="600">${esc(repo.nameWithOwner)}</text>
${desc.map((line, i) => `    <text x="25" y="${62 + i * 18}" fill="${THEME.muted}" font-size="13">${esc(line)}</text>`).join("\n")}
    <g transform="translate(0, ${H - 20})">
    ${meta.join("\n    ")}
    </g>
  </g>`;
  return frame(W, H, `${repo.nameWithOwner}: ${repo.description || "no description"}`, body);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (key === "sample") opts.sample = true;
    else opts[key] = argv[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.out || (!opts.sample && !opts.login)) {
    console.error("Usage: node profile-cards.mjs --login <user> --out <dir> [--wakatime <user>] [--pin <owner/repo>] | --sample --out <dir>");
    process.exit(2);
  }
  await mkdir(opts.out, { recursive: true });

  const cards = {
    "streak.svg + activity.svg": async () => {
      const { name, days } = opts.sample ? sampleDays() : await fetchDays(opts.login);
      if (!days.length) throw new Error("No contribution days returned");
      const stats = computeStats(days);
      await writeFile(join(opts.out, "streak.svg"), renderStreak(stats));
      await writeFile(join(opts.out, "activity.svg"), renderActivity(name, days));
      return `total=${stats.total} current=${stats.current.length} longest=${stats.longest.length}`;
    },
    "top-langs.svg": async () => {
      const langs = opts.sample ? SAMPLE_LANGUAGES : await fetchLanguages(opts.login);
      await writeFile(join(opts.out, "top-langs.svg"), renderLanguages(langs));
      return langs.slice(0, TOP_LANGS).map((l) => `${l.name} ${l.percent.toFixed(1)}%`).join(", ");
    },
  };
  if (opts.sample || opts.wakatime) {
    cards["wakatime.svg"] = async () => {
      const stats = opts.sample ? SAMPLE_WAKATIME : await fetchWakatime(opts.wakatime);
      await writeFile(join(opts.out, "wakatime.svg"), renderWakatime(stats));
      return `total=${stats.total} languages=${stats.languages.length}`;
    };
  }
  if (opts.sample || opts.pin) {
    const file = opts.sample ? "pin-sample.svg" : `pin-${opts.pin.split("/")[1]}.svg`;
    cards[file] = async () => {
      const repo = opts.sample ? SAMPLE_REPO : await fetchRepo(opts.pin);
      await writeFile(join(opts.out, file), renderRepo(repo));
      return repo.nameWithOwner;
    };
  }

  let failed = 0;
  for (const [name, build] of Object.entries(cards)) {
    try {
      console.log(`${name}: ${await build()}`);
    } catch (err) {
      failed++;
      console.log(`::warning::${name} kept its previous version: ${err.message}`);
    }
  }
  if (failed === Object.keys(cards).length) throw new Error("Every card failed to build");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
