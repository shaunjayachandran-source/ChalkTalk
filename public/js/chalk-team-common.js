// Shared helpers for ChalkTalk's public team pages (team.html hub +
// team-offense/defense/slob/blob/special.html subpages).
//
// Loaded as a plain classic script (not a module) so every page can use it
// with a simple <script src="/js/chalk-team-common.js"></script> tag, the
// same duplication-free-but-buildless pattern already used for CSS. Each
// page's own <script type="module"> then imports the Supabase client and
// calls into window.ChalkTeam to do the actual fetch + render.
//
// IMPORTANT (security): real play content — diagrams, coaching notes — must
// NEVER be fetched or rendered on these public pages. Only directory-safe
// columns (title, play_type, phase_count, court_type, updated_at) come from
// the `play_directory` view. Clicking any real play card always opens the
// "ask your coach for an access link" modal; it never reveals content. Do
// not change this behavior.

(function (global) {
  "use strict";

  const CATEGORIES = [
    { key: "offense", label: "Offense", desc: "Half-Court Sets & Coverages", linkDesc: "Man, zone, and press-break sets." },
    { key: "defense", label: "Defense", desc: "Coverages & Principles", linkDesc: "Man, zone, and press coverages." },
    { key: "slob", label: "SLOB", desc: "Sideline Out Of Bounds", linkDesc: "Sideline inbounds calls." },
    { key: "blob", label: "BLOB", desc: "Baseline Out Of Bounds", linkDesc: "Baseline inbounds calls." },
    { key: "special", label: "Specials", desc: "ATOs, Press-Break & End-Game", linkDesc: "ATO, need-a-3, protect-the-lead." },
  ];

  // Sub-groupings shown on the offense/defense subpages. These are display
  // buckets only — inferred from each play's title, never invented data.
  const OFFENSE_SUBGROUPS = ["Man", "Zone", "Press Break"];
  const DEFENSE_SUBGROUPS = ["Man", "Zone", "Press"];

  const INITIALS_OVERRIDES = {
    "melo-16u": "MELO",
    "dematha": "DM",
    "lsu": "LSU",
    "dartmouth": "DART",
  };

  const LEVEL_LABELS = {
    "youth": "YOUTH",
    "high-school": "HIGH SCHOOL",
    "prep": "PREP",
    "college": "COLLEGE",
    "pro": "PRO",
  };

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  function initialsFor(program) {
    const key = (program.slug || "").toLowerCase();
    if (INITIALS_OVERRIDES[key]) return INITIALS_OVERRIDES[key];
    const words = (program.name || program.slug || "?").split(/\s+/).filter(Boolean);
    const letters = words.map((w) => w[0]).join("").toUpperCase();
    return letters.slice(0, 5) || "?";
  }

  function levelLabel(level) {
    if (!level) return "";
    return LEVEL_LABELS[level] || String(level).replace(/-/g, " ").toUpperCase();
  }

  // Deterministic per-program accent color so different programs feel
  // visually distinct without any real crest/photo assets — a simple hash
  // of the slug picks a hue, matching the "richer than a flat placeholder"
  // spirit of the mockups' hand-picked team colors, but generically.
  function hashHue(seed) {
    let h = 0;
    const s = String(seed || "");
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return h % 360;
  }

  function applyAccent(program) {
    const hue = hashHue(program.slug || program.name || "chalktalk");
    const glow = `hsla(${hue}, 70%, 55%, .28)`;
    const crestFrom = `hsl(${hue}, 55%, 30%)`;
    const crestTo = `hsl(${hue}, 55%, 14%)`;
    document.documentElement.style.setProperty("--accent-glow", glow);
    document.documentElement.style.setProperty("--accent-crest", `linear-gradient(160deg, ${crestFrom}, ${crestTo})`);
  }

  function playCard(play, opts) {
    opts = opts || {};
    const div = document.createElement("div");
    div.className = "card play";
    const phaseCount = play.phase_count || "?";
    const court = play.court_type || "half";
    div.innerHTML = `
      <div class="pt-title">${escapeHtml(play.title)}</div>
      <div class="pt-meta">${escapeHtml(phaseCount)} phase${phaseCount === 1 ? "" : "s"} &middot; ${escapeHtml(court)} court</div>
    `;
    div.addEventListener("click", () => {
      const modal = document.getElementById("access-modal");
      if (modal) modal.style.display = "flex";
    });
    return div;
  }

  function ghostCard(label, hint) {
    const div = document.createElement("div");
    div.className = "card ghost";
    div.innerHTML = `
      <span class="plus">+</span>
      <span class="ghost-label">${escapeHtml(label)}</span>
      ${hint ? `<span class="ghost-hint">${escapeHtml(hint)}</span>` : ""}
    `;
    return div;
  }

  function wireAccessModal() {
    const closeBtn = document.getElementById("access-modal-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        document.getElementById("access-modal").style.display = "none";
      });
    }
  }

  // Renders the sticky section-nav shared across the hub + all 5 subpages.
  // `activeKey` is null on the hub (no section active yet).
  function renderSectionNav(slug, activeKey) {
    const qs = slug ? `?slug=${encodeURIComponent(slug)}` : "";
    return CATEGORIES.map((cat) => {
      const cls = cat.key === activeKey ? ' class="active"' : "";
      return `<a href="team-${cat.key}.html${qs}"${cls}>${cat.label}</a>`;
    }).join("\n");
  }

  // ---------------------------------------------------------------------
  // Live search widget — searches whatever items are passed in, built from
  // real Supabase data (category link cards on the hub, or real play
  // titles + ghost sub-category labels on a subpage). No fabricated data.
  // ---------------------------------------------------------------------
  function initSearch(inputId, resultsId, items) {
    const input = document.getElementById(inputId);
    const results = document.getElementById(resultsId);
    if (!input || !results) return;

    let activeIndex = -1;
    let currentMatches = [];

    function highlight(text, query) {
      const idx = text.toLowerCase().indexOf(query.toLowerCase());
      if (idx === -1) return escapeHtml(text);
      return (
        escapeHtml(text.slice(0, idx)) +
        "<mark>" + escapeHtml(text.slice(idx, idx + query.length)) + "</mark>" +
        escapeHtml(text.slice(idx + query.length))
      );
    }

    function search(query) {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      return items.filter((it) =>
        it.label.toLowerCase().indexOf(q) !== -1 ||
        (it.hint && it.hint.toLowerCase().indexOf(q) !== -1) ||
        (it.section && it.section.toLowerCase().indexOf(q) !== -1) ||
        (it.sub && it.sub.toLowerCase().indexOf(q) !== -1)
      );
    }

    function render(matches, query) {
      results.innerHTML = "";
      if (!query) { results.classList.remove("open"); return; }
      if (matches.length === 0) {
        results.innerHTML = `<div class="search-empty">No matches for &quot;${escapeHtml(query)}&quot;. Nothing has been built yet, or try a different term.</div>`;
        results.classList.add("open");
        return;
      }
      matches.slice(0, 8).forEach((m, i) => {
        const row = document.createElement(m.href ? "a" : "button");
        if (m.href) row.href = m.href;
        row.type = "button";
        row.className = "search-row" + (i === activeIndex ? " active" : "");
        row.innerHTML = `<span class="sr-label">${highlight(m.label, query)}</span><span class="sr-path">${escapeHtml(m.section || "")}${m.sub ? " &rsaquo; " + escapeHtml(m.sub) : ""}</span>`;
        if (!m.href) {
          row.addEventListener("click", () => { if (m.onSelect) m.onSelect(); });
        }
        results.appendChild(row);
      });
      results.classList.add("open");
    }

    input.addEventListener("input", () => {
      activeIndex = -1;
      currentMatches = search(input.value);
      render(currentMatches, input.value.trim());
    });

    input.addEventListener("keydown", (e) => {
      if (!results.classList.contains("open")) return;
      const rows = results.querySelectorAll(".search-row");
      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, rows.length - 1);
        rows.forEach((r) => r.classList.remove("active"));
        if (rows[activeIndex]) rows[activeIndex].classList.add("active");
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
        rows.forEach((r) => r.classList.remove("active"));
        if (rows[activeIndex]) rows[activeIndex].classList.add("active");
      } else if (e.key === "Enter") {
        e.preventDefault();
        const target = currentMatches[activeIndex >= 0 ? activeIndex : 0];
        if (target) {
          if (target.href) window.location.href = target.href;
          else if (target.onSelect) target.onSelect();
        }
      } else if (e.key === "Escape") {
        results.classList.remove("open");
        input.blur();
      }
    });

    document.addEventListener("click", (e) => {
      if (e.target !== input && !results.contains(e.target)) {
        results.classList.remove("open");
      }
    });
  }

  // Infers a Man/Zone/Press(-Break) sub-bucket from a play's title text.
  // Returns null if no keyword matches — callers should fall back to a
  // flat (ungrouped) grid rather than inventing a bucket for it.
  function inferSubgroup(play, kind) {
    const t = (play.title || "").toLowerCase();
    if (/\bzone\b/.test(t)) return "Zone";
    if (kind === "offense" && /\bpress\b/.test(t)) return "Press Break";
    if (kind === "defense" && /\bpress\b/.test(t)) return "Press";
    if (/\bman\b/.test(t)) return "Man";
    return null;
  }

  global.ChalkTeam = {
    CATEGORIES,
    OFFENSE_SUBGROUPS,
    DEFENSE_SUBGROUPS,
    escapeHtml,
    initialsFor,
    levelLabel,
    applyAccent,
    playCard,
    ghostCard,
    wireAccessModal,
    renderSectionNav,
    initSearch,
    inferSubgroup,
  };
})(window);
