"use strict";

// ---- Configuration ---------------------------------------------------------

const OWNER = "YoriKv";
const REPOS = ["celpix", "shiny-egg", "shiny-mushroom", "mapchar", "dbkai-view", "M1TE2"];

const API = "https://api.github.com";
const CACHE_KEY = "release-stats-cache-v1";
const CACHE_MAX_AGE_MS = 10 * 60 * 1000; // reuse data for 10 minutes to stay under the API rate limit

const PLATFORMS = [
  { key: "windows", label: "Windows", color: "var(--series-1)" },
  { key: "macos", label: "macOS", color: "var(--series-2)" },
  { key: "linux", label: "Linux", color: "var(--series-3)" },
  { key: "other", label: "Other", color: "var(--series-other)" },
];

// ---- Helpers ---------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("en-US");
const fmt = (n) => nf.format(n);
const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function svg(tag, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  return node;
}

function relativeTime(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365.25);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

function platformOf(assetName) {
  const n = assetName.toLowerCase();
  if (/source|src\b/.test(n)) return "other";
  if (/mac|darwin|osx|\.dmg$|\.pkg$/.test(n)) return "macos";
  if (/linux|\.appimage$|\.deb$|\.rpm$|\.snap$|\.flatpak$/.test(n)) return "linux";
  if (/(^|[^a-z])win(dows|32|64)?([^a-z]|$)|\.exe$|\.msi$|\.msix$|setup/.test(n)) return "windows";
  return "other";
}

function emptyPlatforms() {
  return { windows: 0, macos: 0, linux: 0, other: 0 };
}

// ---- Data ------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, resetAt) {
    super(message);
    this.resetAt = resetAt;
  }
}

let rateLimit = null;

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = res.headers.get("x-ratelimit-reset");
  if (remaining != null) rateLimit = { remaining: Number(remaining), resetAt: new Date(Number(reset) * 1000) };

  if (!res.ok) {
    if ((res.status === 403 || res.status === 429) && remaining === "0") {
      throw new ApiError("GitHub API rate limit reached", rateLimit.resetAt);
    }
    throw new ApiError(`GitHub API returned ${res.status} for ${url}`);
  }
  const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") || "");
  return { data: await res.json(), next: next ? next[1] : null };
}

async function getAllPages(url) {
  const out = [];
  while (url) {
    const page = await getJson(url);
    out.push(...page.data);
    url = page.next;
  }
  return out;
}

async function fetchProject(name) {
  const [repo, releases] = await Promise.all([
    getJson(`${API}/repos/${OWNER}/${name}`).then((r) => r.data),
    getAllPages(`${API}/repos/${OWNER}/${name}/releases?per_page=100`),
  ]);
  return {
    name: repo.name,
    url: repo.html_url,
    description: repo.description,
    language: repo.language,
    stars: repo.stargazers_count,
    createdAt: repo.created_at,
    releases: releases
      .filter((r) => !r.draft)
      .map((r) => ({
        tag: r.tag_name,
        name: r.name,
        url: r.html_url,
        prerelease: r.prerelease,
        publishedAt: r.published_at || r.created_at,
        assets: r.assets.map((a) => ({
          name: a.name,
          url: a.browser_download_url,
          size: a.size,
          downloads: a.download_count,
          platform: platformOf(a.name),
        })),
      })),
  };
}

async function fetchAll() {
  const projects = await Promise.all(REPOS.map(fetchProject));
  return { fetchedAt: new Date().toISOString(), projects };
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {
    /* storage unavailable: the page still works, it just refetches */
  }
}

function summarize(project) {
  const releases = project.releases
    .map((r) => {
      const byPlatform = emptyPlatforms();
      let total = 0;
      for (const a of r.assets) {
        byPlatform[a.platform] += a.downloads;
        total += a.downloads;
      }
      return { ...r, total, byPlatform };
    })
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const byPlatform = emptyPlatforms();
  let total = 0;
  for (const r of releases) {
    total += r.total;
    for (const p of PLATFORMS) byPlatform[p.key] += r.byPlatform[p.key];
  }
  const latest = releases.find((r) => !r.prerelease) || releases[0] || null;
  return { ...project, releases, byPlatform, total, latest };
}

// ---- Tooltip ---------------------------------------------------------------

const tooltip = $("tooltip");

function showTooltip(target, build, event) {
  tooltip.replaceChildren(...build());
  tooltip.hidden = false;
  const box = tooltip.getBoundingClientRect();
  let x, y;
  if (event && event.clientX != null) {
    x = event.clientX + 14;
    y = event.clientY + 14;
  } else {
    const r = target.getBoundingClientRect();
    x = r.right + 8;
    y = r.top;
  }
  if (x + box.width > window.innerWidth - 8) x = Math.max(8, x - box.width - 28);
  if (y + box.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - box.height - 8);
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

function hideTooltip() {
  tooltip.hidden = true;
}

function attachTooltip(node, build) {
  node.addEventListener("pointermove", (e) => showTooltip(node, build, e));
  node.addEventListener("pointerleave", hideTooltip);
  node.addEventListener("focus", () => showTooltip(node, build));
  node.addEventListener("blur", hideTooltip);
}

function releaseTooltip(r) {
  const rows = PLATFORMS.filter((p) => r.byPlatform[p.key] > 0).flatMap((p) => [
    el("span", { class: "tt-key", style: `background:${p.color}` }),
    el("span", { class: "tt-label" }, p.label),
    el("span", null, fmt(r.byPlatform[p.key])),
  ]);
  return [
    el("div", { class: "tt-value" }, `${fmt(r.total)} download${r.total === 1 ? "" : "s"}`),
    el("div", { class: "tt-label" }, `${r.tag}${r.prerelease ? " (pre-release)" : ""} · ${fmtDate(r.publishedAt)}`),
    rows.length ? el("div", { class: "tt-rows" }, rows) : null,
  ];
}

// ---- Rendering -------------------------------------------------------------

function niceMax(v) {
  if (v <= 0) return 4;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  // Even maxima keep the midpoint tick a whole number of downloads.
  for (const m of [1, 2, 3, 4, 5, 6, 8, 10]) {
    const max = m * pow;
    if (max >= v && max % 2 === 0) return Math.max(4, max);
  }
  return 10 * pow;
}

function renderReleaseChart(container, project) {
  container.replaceChildren();
  const releases = [...project.releases].reverse(); // oldest -> newest
  if (!releases.length) {
    container.append(el("div", { class: "chart-empty" }, "No releases yet."));
    return;
  }

  const width = Math.max(260, container.clientWidth);
  const plotH = 150;
  const top = 18;
  const axisH = 26;
  const left = 36;
  const right = 4;
  const height = top + plotH + axisH;
  const plotW = width - left - right;

  const maxVal = Math.max(...releases.map((r) => r.total));
  const yMax = niceMax(maxVal);
  const y = (v) => top + plotH - (v / yMax) * plotH;
  const slot = plotW / releases.length;
  const barW = Math.max(2, Math.min(24, slot - 2, slot * 0.72));

  const root = svg("svg", { width, height, role: "img", "aria-label": `Downloads per release for ${project.name}` });

  const ticks = [0, yMax / 2, yMax];
  for (const t of ticks) {
    const ty = y(t);
    root.append(svg("line", { class: t === 0 ? "baseline" : "grid", x1: left, x2: width - right, y1: ty, y2: ty }));
    const label = svg("text", { x: left - 8, y: ty + 4, "text-anchor": "end" });
    label.textContent = fmt(t);
    root.append(label);
  }

  const maxIndex = releases.findIndex((r) => r.total === maxVal);

  releases.forEach((r, i) => {
    const cx = left + slot * i + slot / 2;
    const h = (r.total / yMax) * plotH;
    if (h > 0) {
      const x0 = cx - barW / 2;
      const yb = top + plotH;
      const rad = Math.min(4, h, barW / 2);
      const d = `M${x0},${yb} V${yb - h + rad} Q${x0},${yb - h} ${x0 + rad},${yb - h} H${x0 + barW - rad} Q${x0 + barW},${yb - h} ${x0 + barW},${yb - h + rad} V${yb} Z`;
      root.append(svg("path", { d, class: `bar${r.prerelease ? " prerelease" : ""}` }));
    }

    if (i === maxIndex && maxVal > 0) {
      const t = svg("text", { x: cx, y: y(r.total) - 6, "text-anchor": "middle", class: "label-strong" });
      t.textContent = fmt(r.total);
      root.append(t);
    }

    const hit = svg("rect", {
      class: "hit",
      x: left + slot * i,
      y: top - 12,
      width: slot,
      height: plotH + 12,
      tabindex: 0,
      "aria-label": `${r.tag}: ${r.total} downloads`,
    });
    attachTooltip(hit, () => releaseTooltip(r));
    root.append(hit);
  });

  // X-axis: first and last release tags, plus the peak if it has room.
  const xLabels = new Map([[0, "start"], [releases.length - 1, "end"]]);
  for (const [i, anchor] of xLabels) {
    const cx = left + slot * i + slot / 2;
    const t = svg("text", { x: anchor === "start" ? Math.max(left, cx - barW / 2) : Math.min(width - right, cx + barW / 2), y: top + plotH + 18, "text-anchor": releases.length === 1 ? "start" : anchor });
    t.textContent = releases[i].tag;
    root.append(t);
    if (releases.length === 1) break;
  }

  container.append(root);
}

function renderProject(project) {
  const card = el("article", { class: "card project", id: `project-${project.name}` });

  card.append(
    el("div", { class: "project-head" },
      el("h2", null, el("a", { href: project.url, target: "_blank", rel: "noopener" }, project.name)),
      el("span", { class: "project-meta" },
        [project.language, `created ${fmtDate(project.createdAt)}`, `★ ${fmt(project.stars)}`].filter(Boolean).join(" · "))),
    project.description ? el("p", { class: "project-desc" }, project.description) : null,
  );

  const latest = project.latest;
  const lastPublished = project.releases[0];
  const tile = (label, value, note) =>
    el("div", { class: "tile" },
      el("div", { class: "tile-label" }, label),
      el("div", { class: "tile-value" }, value),
      el("div", { class: "tile-note" }, note || " "));

  card.append(el("div", { class: "tiles" },
    tile("Total downloads", fmt(project.total), `across ${project.releases.length} release${project.releases.length === 1 ? "" : "s"}`),
    tile("Latest release", latest ? fmt(latest.total) : "–", latest ? `${latest.tag} downloads` : "no releases"),
    tile("Releases", fmt(project.releases.length), project.releases.some((r) => r.prerelease) ? `${project.releases.filter((r) => r.prerelease).length} pre-release` : null),
    tile("Last release", lastPublished ? relativeTime(lastPublished.publishedAt) : "–", lastPublished ? fmtDate(lastPublished.publishedAt) : null),
  ));

  // Platform split
  const platforms = el("div", { class: "platforms" }, el("h3", { class: "section-title" }, "Downloads by platform"));
  const used = PLATFORMS.filter((p) => project.byPlatform[p.key] > 0);
  if (project.total > 0) {
    const stack = el("div", { class: "stack" });
    for (const p of used) {
      const v = project.byPlatform[p.key];
      const seg = el("div", {
        class: "stack-seg",
        style: `flex:${v} 1 0; background:${p.color}`,
        tabindex: 0,
        "aria-label": `${p.label}: ${v} downloads`,
      });
      attachTooltip(seg, () => [
        el("div", { class: "tt-value" }, fmt(v)),
        el("div", { class: "tt-label" }, `${p.label} · ${Math.round((v / project.total) * 100)}%`),
      ]);
      stack.append(seg);
    }
    platforms.append(stack);
  } else {
    platforms.append(el("div", { class: "stack-empty" }));
  }
  platforms.append(el("div", { class: "legend" },
    (used.length ? used : PLATFORMS.slice(0, 3)).map((p) => {
      const v = project.byPlatform[p.key];
      return el("span", { class: "legend-item" },
        el("span", { class: "swatch", style: `background:${p.color}` }),
        p.label,
        el("strong", null, fmt(v)),
        project.total ? `(${Math.round((v / project.total) * 100)}%)` : null);
    })));
  card.append(platforms);

  // Downloads per release chart
  const chart = el("div", { class: "chart" });
  card.append(el("h3", { class: "section-title" }, "Downloads per release"), chart);
  chartRenderers.push(() => renderReleaseChart(chart, project));

  // Releases table
  if (project.releases.length) {
    const cols = PLATFORMS.filter((p) => project.releases.some((r) => r.byPlatform[p.key] > 0));
    const tbody = el("tbody");
    project.releases.forEach((r) => {
      const assetRows = r.assets
        .slice()
        .sort((a, b) => b.downloads - a.downloads)
        .map((a, i, arr) =>
          el("tr", { class: `asset-row${i === arr.length - 1 ? " last" : ""}`, hidden: true },
            el("td", { class: "left", colspan: 2 }, el("a", { href: a.url }, a.name), ` · ${(a.size / 1048576).toFixed(1)} MB`),
            cols.map((p) => el("td", null, a.platform === p.key ? fmt(a.downloads) : "")),
            el("td", null, fmt(a.downloads))));

      const toggle = assetRows.length
        ? el("button", {
            class: "expand",
            type: "button",
            "aria-expanded": "false",
            "aria-label": `Show assets for ${r.tag}`,
            onclick: (e) => {
              const open = e.currentTarget.getAttribute("aria-expanded") !== "true";
              e.currentTarget.setAttribute("aria-expanded", String(open));
              e.currentTarget.textContent = open ? "▾" : "▸";
              for (const row of assetRows) row.hidden = !open;
            },
          }, "▸")
        : el("span", { class: "expand" });

      tbody.append(
        el("tr", null,
          el("td", { class: "left" }, toggle,
            el("a", { href: r.url, target: "_blank", rel: "noopener" }, r.tag),
            r === project.latest ? el("span", { class: "badge latest" }, "Latest") : null,
            r.prerelease ? el("span", { class: "badge" }, "Pre-release") : null),
          el("td", { class: "left" }, fmtDate(r.publishedAt)),
          cols.map((p) => el("td", { class: r.byPlatform[p.key] ? "" : "zero" }, fmt(r.byPlatform[p.key]))),
          el("td", { class: `total${r.total ? "" : " zero"}` }, fmt(r.total))),
        ...assetRows);
    });

    card.append(el("details", { class: "releases" },
      el("summary", null, `All releases (${project.releases.length})`),
      el("div", { class: "table-wrap" },
        el("table", null,
          el("thead", null, el("tr", null,
            el("th", { class: "left" }, "Release"), el("th", { class: "left" }, "Published"),
            cols.map((p) => el("th", null, p.label)),
            el("th", null, "Total"))),
          tbody))));
  }

  return card;
}

function renderOverview(projects) {
  const section = $("overview");
  const total = projects.reduce((s, p) => s + p.total, 0);
  const releaseCount = projects.reduce((s, p) => s + p.releases.length, 0);
  const max = Math.max(1, ...projects.map((p) => p.total));

  const bars = el("div", { class: "hbars" });
  for (const p of projects) {
    const fill = el("div", { class: "hbar-fill", style: `width:${(p.total / max) * 100}%` });
    bars.append(
      el("a", { class: "hbar-name", href: `#project-${p.name}` }, p.name),
      el("div", { class: "hbar-track", role: "presentation" }, p.total > 0 ? fill : null),
      el("div", { class: "hbar-value" }, fmt(p.total)));
  }

  section.replaceChildren(el("div", { class: "overview-grid" },
    el("div", null,
      el("div", { class: "hero-label" }, "Total downloads"),
      el("div", { class: "hero-value" }, fmt(total)),
      el("div", { class: "hero-sub" }, `${projects.length} projects · ${releaseCount} releases`)),
    bars));
  section.hidden = false;
}

let chartRenderers = [];

function render(data) {
  const projects = data.projects
    .map(summarize)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  chartRenderers = [];
  renderOverview(projects);
  $("projects").replaceChildren(...projects.map(renderProject));
  for (const draw of chartRenderers) draw();
}

// ---- Controller ------------------------------------------------------------

function setStatus(data) {
  const parts = [];
  if (data) parts.push(`Updated ${new Date(data.fetchedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`);
  if (rateLimit) parts.push(`${rateLimit.remaining} API calls left`);
  $("status").textContent = parts.join(" · ");
}

function setNotice(message) {
  const notice = $("notice");
  notice.textContent = message || "";
  notice.hidden = !message;
}

async function load(force) {
  const cached = readCache();
  if (cached) {
    render(cached);
    setStatus(cached);
    if (!force && Date.now() - new Date(cached.fetchedAt).getTime() < CACHE_MAX_AGE_MS) return;
  } else {
    $("projects").replaceChildren(el("div", { class: "skeleton-text" }, "Loading release data from GitHub…"));
  }

  const button = $("refresh");
  button.disabled = true;
  $("projects").classList.add("loading");
  $("overview").classList.add("loading");
  try {
    const data = await fetchAll();
    writeCache(data);
    setNotice(null);
    render(data);
    setStatus(data);
  } catch (err) {
    console.error(err);
    const when = err.resetAt ? ` It resets at ${err.resetAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.` : "";
    setNotice(`${err.message}.${when}${cached ? " Showing the last data loaded." : ""}`);
    if (!cached) $("projects").replaceChildren();
    setStatus(cached);
  } finally {
    button.disabled = false;
    $("projects").classList.remove("loading");
    $("overview").classList.remove("loading");
  }
}

$("owner-link").textContent = OWNER;
$("owner-link").href = `https://github.com/${OWNER}`;
$("refresh").addEventListener("click", () => load(true));

let resizeTimer;
let lastWidth = window.innerWidth;
window.addEventListener("resize", () => {
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => chartRenderers.forEach((draw) => draw()), 150);
});

load(false);
