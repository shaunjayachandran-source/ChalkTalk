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
// columns (title, play_type, phase_count, court_type, updated_at, and now
// `id` -- see getPlaysForViewer) come from the `play_directory` view.
// Clicking any real play card always opens the "you need a real login"
// modal; it never reveals content. Do not change this behavior.

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

  // Fallback only — used when a program has no explicit `crest_label` set in
  // the database. Real programs should set crest_label/color_primary/
  // color_secondary explicitly (see the SQL migration) rather than rely on
  // this guessed-from-name fallback, since guessing has already been wrong
  // once (Dartmouth as "DART").
  const INITIALS_OVERRIDES = {
    "melo-16u": "MELO",
    "dematha": "DM",
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
    if (program && program.crest_label) return program.crest_label;
    const key = ((program && program.slug) || "").toLowerCase();
    if (INITIALS_OVERRIDES[key]) return INITIALS_OVERRIDES[key];
    const words = ((program && program.name) || (program && program.slug) || "?").split(/\s+/).filter(Boolean);
    const letters = words.map((w) => w[0]).join("").toUpperCase();
    return letters.slice(0, 5) || "?";
  }

  // Renders the crest circle's contents in priority order: a real inline
  // SVG mark (`crest_svg` -- used for a hand-drawn emblem with no verified
  // real logo asset, e.g. Monarchs' crown), then a real logo image
  // (`crest_image_url` -- a genuine team logo, e.g. Dartmouth's), then
  // falling back to plain text initials (`initialsFor`). `crestEl` is the
  // .crest container div itself, not the inner span -- this function owns
  // and replaces its entire contents.
  function renderCrest(crestEl, program) {
    if (!crestEl) return;
    crestEl.innerHTML = "";
    if (program && program.crest_svg) {
      // Trusted content: crest_svg is only ever set by us (via SQL/the
      // Branding editor), never derived from arbitrary user input, so
      // innerHTML here is the same trust boundary as any other
      // coach-authored field already rendered on this page.
      crestEl.innerHTML = program.crest_svg;
      return;
    }
    if (program && program.crest_image_url) {
      const img = document.createElement("img");
      img.src = program.crest_image_url;
      img.alt = `${program.name || "Team"} logo`;
      img.style.width = "70%";
      img.style.height = "70%";
      img.style.objectFit = "contain";
      crestEl.appendChild(img);
      return;
    }
    const span = document.createElement("span");
    span.textContent = initialsFor(program);
    crestEl.appendChild(span);
  }

  // Builds the small "sign accent" line under the hero -- location + venue,
  // e.g. "BATON ROUGE, LOUISIANA · PETE MARAVICH ASSEMBLY CENTER". Falls
  // back to the generic directory tagline when a program hasn't had this
  // real data entered yet, so melo-16u/dematha and any future program
  // without location/venue set keep their existing look, no regression.
  function signAccentFor(program) {
    const parts = [];
    if (program && program.location_label) parts.push(program.location_label.toUpperCase());
    if (program && program.venue_label) parts.push(program.venue_label.toUpperCase());
    if (!parts.length) return "COACH-BUILT PLAYBOOK DIRECTORY";
    return parts.map(escapeHtml).join(" &middot; ");
  }

  // League goes alongside the level in the small mono subtitle line (e.g.
  // "COLLEGE · SEC"), matching the earlier mockups' team_sub treatment.
  // Falls back to just the level label when a program has no league set.
  function teamSubFor(program) {
    const levelLbl = levelLabel(program && program.level);
    const parts = [];
    if (levelLbl) parts.push(escapeHtml(levelLbl));
    if (program && program.league_label) parts.push(escapeHtml(program.league_label));
    parts.push("<b>CHALKTALK PLAYBOOK</b>");
    return parts.join(" &middot; ");
  }

  function levelLabel(level) {
    if (!level) return "";
    return LEVEL_LABELS[level] || String(level).replace(/-/g, " ").toUpperCase();
  }

  // Levels at which it's appropriate to publicly name the head coach on the
  // team hub page. Named college/pro coaches are public figures with public
  // rosters; naming a specific coach at youth/high-school/prep level is more
  // privacy-sensitive given this app's audience skews youth/HS, so those
  // levels always fall back to the generic audience line instead.
  const COACH_NAME_LEVELS = ["college", "pro"];

  // Only the youth level's audience line mentions parents by name — every
  // other level (high-school, prep, college, pro) phrases the line as
  // players & coaches only.
  function coachLineFor(program) {
    const level = program.level || "";
    const levelLbl = levelLabel(level);
    // A program can opt in to showing its coach's name even below college/
    // pro level via `coach_name_public` -- e.g. RPCS, whose source material
    // already names the coach publicly. This is a deliberate per-program
    // override, not a change to the default privacy rule for youth/HS/prep.
    if ((COACH_NAME_LEVELS.indexOf(level) !== -1 || program.coach_name_public) && program.coach_name) {
      return `Head Coach ${escapeHtml(program.coach_name)} &middot; Built for players &amp; coaches`;
    }
    if (level === "youth") {
      return levelLbl
        ? `Built for ${levelLbl.toLowerCase()} players, parents &amp; coaches`
        : "Built for players, parents &amp; coaches";
    }
    return levelLbl
      ? `Built for ${levelLbl.toLowerCase()} players &amp; coaches`
      : "Built for players &amp; coaches";
  }

  // Inserts (or removes) the optional hero photo + credit line. `heroEl` is
  // the .hero container; `photoUrl`/`creditLabel`/`creditHref` come straight
  // from the programs row. When photoUrl is falsy, this is a no-op and the
  // plain gradient-crest hero renders exactly as it did before photos
  // existed in the data model.
  function renderHeroPhoto(heroEl, program) {
    if (!heroEl || !program || !program.hero_photo_url) return;
    const photoDiv = document.createElement("div");
    photoDiv.className = "hero-photo";
    const img = document.createElement("img");
    img.src = program.hero_photo_url;
    img.alt = "";
    img.loading = "eager";
    photoDiv.appendChild(img);
    heroEl.insertBefore(photoDiv, heroEl.firstChild);

    if (program.photo_credit_label) {
      const credit = document.createElement("div");
      credit.className = "photo-credit";
      if (program.photo_credit_url) {
        const a = document.createElement("a");
        a.href = program.photo_credit_url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = program.photo_credit_label;
        credit.appendChild(a);
      } else {
        credit.textContent = program.photo_credit_label;
      }
      heroEl.appendChild(credit);
    }
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

  // Prefer the program's real official colors (color_primary/color_secondary,
  // set explicitly in the database — see the SQL migration) over the
  // hash-based placeholder. The hash fallback only kicks in for programs
  // that haven't had real colors entered yet, so future programs still look
  // visually distinct out of the box before anyone gets around to it.
  function applyAccent(program) {
    if (program && program.color_primary) {
      const primary = program.color_primary;
      const secondary = program.color_secondary || primary;
      document.documentElement.style.setProperty("--accent-glow", hexToGlow(primary));
      document.documentElement.style.setProperty("--accent-crest", `linear-gradient(160deg, ${primary}, ${secondary})`);
      document.documentElement.style.setProperty("--crest-font", (program.crest_font || "'Bebas Neue', sans-serif"));
      return;
    }
    const hue = hashHue((program && program.slug) || (program && program.name) || "chalktalk");
    const glow = `hsla(${hue}, 70%, 55%, .28)`;
    const crestFrom = `hsl(${hue}, 55%, 30%)`;
    const crestTo = `hsl(${hue}, 55%, 14%)`;
    document.documentElement.style.setProperty("--accent-glow", glow);
    document.documentElement.style.setProperty("--accent-crest", `linear-gradient(160deg, ${crestFrom}, ${crestTo})`);
    document.documentElement.style.setProperty("--crest-font", "'Bebas Neue', sans-serif");
  }

  // Converts a #rrggbb hex color to a translucent glow color for the hero
  // background radial gradient. Falls back to a neutral gold glow if the
  // color string doesn't parse (defensive — real data should always be a
  // clean hex string).
  function hexToGlow(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return "rgba(240,180,41,.28)";
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r}, ${g}, ${b}, .32)`;
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
      // A logged-in, authorized coach gets opts.onOpen wired up by the page
      // (see getPlaysForViewer/makePlayOpener below) -- everyone else still
      // gets the login modal, which now (Sep 15, 2026) remembers which play
      // was clicked so login can drop the visitor straight back into it --
      // see showAccessModal().
      if (opts.onOpen) {
        opts.onOpen(play);
        return;
      }
      showAccessModal(play.id);
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

  // Shows the "you need a real login" modal, remembering which play was
  // clicked (in sessionStorage, same-origin, cleared on use or on Cancel)
  // so that /login.html or /player-login.html can drop the visitor
  // straight back into THIS play once they've signed in, instead of just
  // dumping them on their dashboard/home page -- added Sep 15, 2026 per
  // Shaun's explicit ask. `playId` can be omitted (falls back to showing
  // the modal with no pending play) for any caller that doesn't have one.
  function showAccessModal(playId) {
    if (playId) {
      try {
        sessionStorage.setItem("ct_pending_play_id", playId);
      } catch (err) {
        // Private-browsing/storage-blocked visitors just don't get the
        // deep-link-back behavior -- the modal and its login links still
        // work fine without it.
      }
    }
    const modal = document.getElementById("access-modal");
    if (modal) modal.style.display = "flex";
  }

  function wireAccessModal() {
    const closeBtn = document.getElementById("access-modal-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        // Cancelling means abandon intent -- don't let a stale pending play
        // hijack some unrelated later login.
        try {
          sessionStorage.removeItem("ct_pending_play_id");
        } catch (err) {}
        document.getElementById("access-modal").style.display = "none";
      });
    }
  }

  // Coach-aware play list. Checks for an active Supabase Auth session; if
  // the visitor is a real, logged-in coach with a program_coaches row for
  // this program, reads the real `plays` table directly (RLS already
  // restricts this to their own program's roster) instead of the public
  // `play_directory` view, and returns the session's access token so the
  // page can open real play content instead of showing the private-play
  // modal. Every other visitor (not logged in, or logged in but not on
  // this program's roster) gets back exactly the same anonymous
  // play_directory result as before -- this never widens what the public
  // page shows, it only adds a path for an already-authorized coach.
  async function getPlaysForViewer(supabase, programId, viewColumns) {
    let accessToken = null;
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const session = sessionData && sessionData.session;
      if (session) {
        const { data: membership } = await supabase
          .from("program_coaches")
          .select("id")
          .eq("program_id", programId)
          .eq("coach_id", session.user.id)
          .maybeSingle();
        if (membership) accessToken = session.access_token;
      }
    } catch (err) {
      // Never let a session-check failure break the public page -- fall
      // through to the same anonymous view every visitor already gets.
    }
 
    if (accessToken) {
      const { data } = await supabase
        .from("plays")
        .select("id, " + viewColumns)
        .eq("program_id", programId)
        .eq("status", "published")
        .eq("hidden", false);
      return { plays: data || [], accessToken };
    }
 
    // Include `id` here too (Sep 15, 2026) so an anonymous visitor's play
    // card can remember which play they clicked and deep-link them straight
    // back into it after they log in (see showAccessModal() below) -- a
    // play's id isn't sensitive on its own, view-play.js still requires a
    // real authorized session to ever see the actual content. Falls back to
    // the id-less query if the live play_directory view doesn't expose id
    // yet, so the directory itself never breaks either way.
    const { data, error } = await supabase
      .from("play_directory")
      .select("id, " + viewColumns)
      .eq("program_id", programId);
    if (!error) return { plays: data || [], accessToken: null };

    const { data: fallbackData } = await supabase
      .from("play_directory")
      .select(viewColumns)
      .eq("program_id", programId);
    return { plays: fallbackData || [], accessToken: null };
  }
 
  // Returns a click handler for playCard (and for a search result's
  // onSelect) that opens the real play via api/view-play.js when the
  // viewer is an authorized coach (accessToken set), or falls back to the
  // existing private-play modal for everyone else.
  function makePlayOpener(accessToken) {
    return async function openPlay(play) {
      if (!accessToken || !play.id) {
        showAccessModal(play && play.id);
        return;
      }
      try {
        const res = await fetch(`/api/view-play?playId=${encodeURIComponent(play.id)}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const html = await res.text();
        const win = window.open("", "_blank");
        if (win) {
          win.document.write(html);
          win.document.close();
        }
      } catch (err) {
        alert("Couldn't open this play: " + err.message);
      }
    };
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

  // Maps the real `sub_category` DB value (set explicitly by the coach at
  // play-creation time — see public/create.html) to its display label for
  // the offense/defense subpages. No inference from title text anymore:
  // every offense/defense play carries an explicit sub_category, so there
  // is no "Other" bucket to fall back to.
  const SUBGROUP_LABELS = {
    man: "Man",
    zone: "Zone",
    press_break: "Press Break",
    press: "Press",
  };

  function subgroupLabel(subCategory) {
    return SUBGROUP_LABELS[subCategory] || null;
  }

  global.ChalkTeam = {
    CATEGORIES,
    OFFENSE_SUBGROUPS,
    DEFENSE_SUBGROUPS,
    escapeHtml,
    initialsFor,
    renderCrest,
    signAccentFor,
    teamSubFor,
    levelLabel,
    coachLineFor,
    renderHeroPhoto,
    applyAccent,
    playCard,
    ghostCard,
    wireAccessModal,
    getPlaysForViewer,
    makePlayOpener,
    renderSectionNav,
    initSearch,
    subgroupLabel,
  };
})(window);
