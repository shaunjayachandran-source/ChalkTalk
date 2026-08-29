#!/usr/bin/env python3
# -*- coding: ascii -*-
"""Generates the multi-page ChalkTalk team hubs with a shared client-side
search widget. Pure ASCII output; entities used for any punctuation that
would otherwise be non-ASCII.

TEAM DATA now lives in programs/*.json (one file per program) instead of
a hardcoded dict, so new programs can be added by dropping in a JSON file
-- see PROGRAMS_DIR below -- rather than hand-editing this script. This is
what api/create-program.js commits to a feature branch, and what the
"Build programs" GitHub Action (.github/workflows/build-programs.yml)
picks up to regenerate the static hub/section HTML on that branch.

Required fields per program JSON: slug, file_prefix, title, team_name,
team_sub, hero_line, sign_accent, coach_line, crest_html, accent_glow,
accent_crest, notes_text, tagline, beta_status.
hero_mode is "photo" or "art":
  - "photo" also needs hero_photo_file (looked up in ASSET_DIR),
    hero_photo_alt, hero_photo_credit. If the file is missing (e.g. a new
    program hasn't had a real hero photo uploaded yet), this falls back
    to a generated "art" background instead of failing the whole build --
    see load_hero_visual() below.
  - "art" can supply its own hero_art SVG string, or omit it entirely to
    get a generic gradient pattern built from accent_glow/accent_crest.
"""

import os
import sys
import json
import glob
import base64

OUT = os.environ.get("CHALKTALK_BUILD_OUT", "public")
ASSET_DIR = os.environ.get("CHALKTALK_ASSET_DIR", "public/assets/hero-photos")
PROGRAMS_DIR = os.environ.get("CHALKTALK_PROGRAMS_DIR", "programs")


def load_photo_data_uri(filename):
    path = os.path.join(ASSET_DIR, filename)
    with open(path, "rb") as f:
        raw = f.read()
    b64 = base64.b64encode(raw).decode("ascii")
    return "data:image/jpeg;base64,{0}".format(b64)


def generic_hero_art(accent_glow, accent_crest):
    """Fallback hero background for a program that has no hand-drawn
    hero_art and no usable hero photo yet -- just the accent color
    rendered as a soft diagonal wash, same rig as the ghost-card treatment
    elsewhere on the page. Never fails."""
    return (
        '<svg viewBox="0 0 900 260" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg">'
        '<rect x="0" y="0" width="900" height="260" fill="#0d1017"/>'
        '<rect x="0" y="0" width="900" height="260" fill="{glow}"/>'
        '<rect x="0" y="230" width="900" height="30" fill="#05070b" fill-opacity="0.6"/>'
        '<g transform="translate(430,150)" stroke="#f0b429" stroke-width="2.5" fill="none" opacity="0.4">'
        '<line x1="0" y1="0" x2="0" y2="60"/>'
        '<rect x="-22" y="0" width="44" height="26"/>'
        '<ellipse cx="0" cy="30" rx="18" ry="5"/>'
        '</g>'
        '</svg>'
    ).format(glow=accent_glow)


def load_programs():
    """Reads every programs/*.json file into the same shape TEAMS used to
    be, keyed by slug. Any single bad JSON file is reported and skipped
    rather than crashing the whole build -- one malformed submission
    shouldn't take every other program's hub page down with it."""
    programs = {}
    pattern = os.path.join(PROGRAMS_DIR, "*.json")
    for path in sorted(glob.glob(pattern)):
        try:
            with open(path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except (ValueError, OSError) as exc:
            print("WARNING: skipping {0}: {1}".format(path, exc), file=sys.stderr)
            continue

        slug = cfg.get("slug") or os.path.splitext(os.path.basename(path))[0]
        missing = [k for k in ("file_prefix", "title", "team_name") if not cfg.get(k)]
        if missing:
            print("WARNING: skipping {0}: missing required field(s) {1}".format(path, missing), file=sys.stderr)
            continue

        programs[slug] = cfg
    return programs


TEAMS = load_programs()

# ---------------------------------------------------------------------------
# SHARED CSS (identical across every page of every team)
# ---------------------------------------------------------------------------
BASE_CSS = """
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500;700&family=DM+Mono:wght@400;500&display=swap');

  :root{
    --bg:#0d1017;
    --bg-raised:#141a24;
    --card:#161c27;
    --line:#232b38;
    --gold:#f0b429;
    --gold-soft:#f7cf6a;
    --teal:#1abc9c;
    --ember:#ff5a3c;
    --text:#eef1f6;
    --dim:#8b93a3;
    --dim2:#5c6472;
  }

  *{box-sizing:border-box;margin:0;padding:0;}
  html{scroll-behavior:smooth;}
  body{
    background:var(--bg);
    color:var(--text);
    font-family:'DM Sans',sans-serif;
    -webkit-font-smoothing:antialiased;
    overflow-x:hidden;
  }
  a{color:inherit;text-decoration:none;}

  .eyebrow{
    font-family:'DM Mono',monospace;
    letter-spacing:.22em;
    text-transform:uppercase;
    font-size:.68rem;
    color:var(--gold);
  }

  /* ---------- HERO (hub page only) ---------- */
  .hero{
    position:relative;
    min-height:56vh;
    display:flex;
    flex-direction:column;
    align-items:center;
    justify-content:flex-end;
    padding:48px 24px 40px;
    overflow:hidden;
    border-bottom:1px solid var(--line);
  }
  .hero-tex{
    position:absolute;
    inset:0;
    background:
      radial-gradient(ellipse 60% 50% at 50% 15%, var(--accent-glow), transparent 70%),
      radial-gradient(ellipse 80% 60% at 50% 100%, rgba(240,180,41,.06), transparent 70%),
      repeating-linear-gradient(115deg, rgba(255,255,255,.015) 0 2px, transparent 2px 34px);
  }
  .hero-fade{
    position:absolute;
    inset:0;
    background:linear-gradient(180deg, rgba(13,16,23,.35) 0%, rgba(13,16,23,.55) 35%, rgba(13,16,23,.72) 65%, var(--bg) 96%);
  }
  .hero-photo{
    position:absolute;
    inset:0;
    overflow:hidden;
  }
  .hero-photo img{
    width:100%;
    height:100%;
    object-fit:cover;
    object-position:center 20%;
    display:block;
    filter:brightness(.5) saturate(1.15);
  }
  .hero-art{
    position:absolute;
    inset:0;
    overflow:hidden;
  }
  .hero-art svg{
    width:100%;
    height:100%;
    display:block;
  }
  .photo-credit{
    position:absolute;
    right:14px;
    bottom:10px;
    z-index:3;
    font-family:'DM Mono',monospace;
    font-size:.6rem;
    letter-spacing:.04em;
    color:rgba(238,241,246,.45);
    text-shadow:0 1px 3px rgba(0,0,0,.6);
  }
  .photo-credit a{color:rgba(238,241,246,.6);text-decoration:underline;}
  .hero-inner{
    position:relative;
    z-index:2;
    display:flex;
    flex-direction:column;
    align-items:center;
    text-align:center;
    gap:14px;
    width:100%;
  }
  .crest{
    width:88px;
    height:88px;
    border-radius:50%;
    display:flex;
    align-items:center;
    justify-content:center;
    background:var(--accent-crest);
    border:2px solid var(--gold);
    box-shadow:0 0 0 5px rgba(240,180,41,.08), 0 10px 30px rgba(0,0,0,.5);
    animation:riseIn 1.1s ease-out both;
  }
  .crest span{
    font-family:'Bebas Neue',sans-serif;
    font-size:2rem;
    letter-spacing:.02em;
    color:var(--gold-soft);
  }
  .team-name{
    font-family:'Bebas Neue',sans-serif;
    font-size:clamp(2.4rem,7.5vw,4.4rem);
    line-height:.92;
    letter-spacing:.02em;
    background:linear-gradient(180deg,#fff, var(--gold-soft) 70%, var(--gold));
    -webkit-background-clip:text;
    background-clip:text;
    color:transparent;
    filter:drop-shadow(0 2px 10px rgba(0,0,0,.65));
    animation:riseIn 1.1s .1s ease-out both;
  }
  .team-sub{
    font-family:'DM Mono',monospace;
    letter-spacing:.32em;
    text-transform:uppercase;
    font-size:.76rem;
    color:var(--dim);
    animation:riseIn 1.1s .2s ease-out both;
  }
  .team-sub b{color:var(--teal);font-weight:500;}
  .hero-line{
    margin-top:4px;
    max-width:540px;
    color:var(--dim);
    font-size:.9rem;
    line-height:1.5;
    animation:riseIn 1.1s .3s ease-out both;
  }
  @keyframes riseIn{
    from{opacity:0; transform:translateY(14px);}
    to{opacity:1; transform:translateY(0);}
  }
  .sign-accent{
    display:inline-flex;
    align-items:center;
    gap:8px;
    margin-top:14px;
    padding:6px 14px;
    border:1px solid rgba(240,180,41,.4);
    border-radius:3px;
    background:rgba(240,180,41,.06);
    font-family:'DM Mono',monospace;
    font-size:.66rem;
    letter-spacing:.18em;
    text-transform:uppercase;
    color:var(--gold-soft);
    animation:riseIn 1.1s .4s ease-out both;
  }
  .sign-accent i{
    width:6px;height:6px;border-radius:50%;
    background:var(--gold);
    box-shadow:0 0 8px var(--gold);
  }
  .coach-line{
    margin-top:10px;
    font-family:'DM Mono',monospace;
    font-size:.66rem;
    letter-spacing:.1em;
    color:var(--dim2);
    animation:riseIn 1.1s .45s ease-out both;
  }
  .coach-line b{color:var(--dim);font-weight:500;}
  .beta-pill{
    display:inline-block;
    margin-top:10px;
    padding:3px 10px;
    border-radius:12px;
    font-family:'DM Mono',monospace;
    font-size:.6rem;
    letter-spacing:.14em;
    text-transform:uppercase;
    border:1px solid rgba(26,188,156,.4);
    background:rgba(26,188,156,.08);
    color:var(--teal);
  }

  /* ---------- SEARCH ---------- */
  .search-wrap{
    position:relative;
    width:100%;
    max-width:520px;
    margin:22px auto 0;
    z-index:5;
  }
  .search-wrap input{
    width:100%;
    background:var(--bg-raised);
    border:1px solid var(--line);
    border-radius:24px;
    padding:13px 20px;
    color:var(--text);
    font-family:'DM Sans',sans-serif;
    font-size:.9rem;
    outline:none;
    transition:border-color .2s ease, box-shadow .2s ease;
  }
  .search-wrap input::placeholder{color:var(--dim2);}
  .search-wrap input:focus{
    border-color:var(--gold);
    box-shadow:0 0 0 3px rgba(240,180,41,.12);
  }
  .search-results{
    display:none;
    position:absolute;
    top:calc(100% + 8px);
    left:0;
    right:0;
    background:var(--card);
    border:1px solid var(--line);
    border-radius:10px;
    overflow:hidden;
    box-shadow:0 16px 40px rgba(0,0,0,.5);
    max-height:320px;
    overflow-y:auto;
  }
  .search-results.open{display:block;}
  .search-row{
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:12px;
    padding:11px 16px;
    border-bottom:1px solid var(--line);
    text-align:left;
    color:var(--text);
    font-size:.84rem;
  }
  .search-row:last-child{border-bottom:none;}
  .search-row:hover, .search-row.active{background:rgba(240,180,41,.08);}
  .search-row mark{
    background:none;
    color:var(--gold);
    font-weight:600;
  }
  .search-row .sr-path{
    font-family:'DM Mono',monospace;
    font-size:.62rem;
    letter-spacing:.08em;
    text-transform:uppercase;
    color:var(--dim2);
    white-space:nowrap;
  }
  .search-empty{
    padding:14px 16px;
    font-size:.8rem;
    color:var(--dim2);
    line-height:1.5;
  }

  /* ---------- BREADCRUMB / PAGE HEADER (section pages) ---------- */
  .page-header{
    max-width:1180px;
    margin:0 auto;
    padding:26px 28px 18px;
  }
  .home-link{
    display:inline-flex;
    align-items:center;
    gap:6px;
    font-family:'DM Mono',monospace;
    font-size:.68rem;
    letter-spacing:.1em;
    text-transform:uppercase;
    color:var(--dim);
    margin-bottom:16px;
  }
  .home-link:hover{color:var(--gold-soft);}
  .page-title-row{
    display:flex;
    align-items:baseline;
    justify-content:space-between;
    flex-wrap:wrap;
    gap:10px 20px;
  }
  .page-title-row h1{
    font-family:'Bebas Neue',sans-serif;
    font-size:clamp(2.2rem,6vw,3.2rem);
    letter-spacing:.02em;
  }
  .page-title-row .team-tag{
    font-family:'DM Mono',monospace;
    font-size:.68rem;
    letter-spacing:.14em;
    text-transform:uppercase;
    color:var(--dim2);
  }

  /* ---------- PAGE NAV (sibling section pages) ---------- */
  .section-nav{
    position:sticky;
    top:0;
    z-index:10;
    display:flex;
    justify-content:center;
    gap:6px;
    padding:14px 16px;
    background:rgba(13,16,23,.86);
    backdrop-filter:blur(10px);
    border-bottom:1px solid var(--line);
    flex-wrap:wrap;
  }
  .section-nav a{
    font-family:'DM Mono',monospace;
    font-size:.72rem;
    letter-spacing:.18em;
    text-transform:uppercase;
    color:var(--dim);
    padding:8px 16px;
    border-radius:20px;
    border:1px solid transparent;
    transition:color .2s ease, border-color .2s ease, background .2s ease;
  }
  .section-nav a:hover{color:var(--text);}
  .section-nav a.active{
    color:var(--gold);
    border-color:rgba(240,180,41,.35);
    background:rgba(240,180,41,.06);
  }

  /* ---------- SECTIONS ---------- */
  .section{
    max-width:1180px;
    margin:0 auto;
    padding:36px 28px 24px;
  }
  .section-head{
    display:flex;
    align-items:baseline;
    justify-content:space-between;
    flex-wrap:wrap;
    gap:8px 24px;
    margin-bottom:30px;
    border-bottom:1px solid var(--line);
    padding-bottom:18px;
  }
  .section-head h2{
    font-family:'Bebas Neue',sans-serif;
    font-size:2.6rem;
    letter-spacing:.03em;
  }
  .section-head p{
    font-family:'DM Mono',monospace;
    font-size:.72rem;
    letter-spacing:.14em;
    text-transform:uppercase;
    color:var(--dim2);
  }
  .grid{
    display:grid;
    grid-template-columns:repeat(auto-fill,minmax(240px,1fr));
    gap:16px;
  }
  .grid + .subhead{margin-top:34px;}

  .subhead{
    display:flex;
    align-items:center;
    gap:10px;
    font-family:'DM Mono',monospace;
    font-size:.7rem;
    font-weight:500;
    letter-spacing:.18em;
    text-transform:uppercase;
    color:var(--teal);
    margin:0 0 14px;
  }
  .subhead::after{
    content:'';
    flex:1;
    height:1px;
    background:var(--line);
  }

  /* ---------- Ghost / empty-state card ---------- */
  .card.ghost{
    position:relative;
    border:1px dashed #2c3646;
    border-left:1px dashed #2c3646;
    background:transparent;
    border-radius:6px;
    padding:20px 20px 18px;
    min-height:150px;
    display:flex;
    flex-direction:column;
    align-items:center;
    justify-content:center;
    text-align:center;
    color:var(--dim2);
    cursor:default;
    scroll-margin-top:90px;
    transition:border-color .3s ease, background .3s ease;
  }
  .card.ghost:hover{
    border-color:var(--gold);
    color:var(--gold-soft);
    background:rgba(240,180,41,.04);
  }
  .card.ghost.flash{
    border-color:var(--gold);
    background:rgba(240,180,41,.1);
    box-shadow:0 0 0 3px rgba(240,180,41,.18);
  }
  .card.ghost .plus{
    font-family:'Bebas Neue',sans-serif;
    font-size:2.2rem;
    line-height:1;
  }
  .card.ghost .ghost-label{
    font-family:'DM Mono',monospace;
    font-size:.68rem;
    letter-spacing:.14em;
    text-transform:uppercase;
    margin-top:6px;
  }
  .card.ghost .ghost-hint{
    font-size:.76rem;
    color:var(--dim2);
    margin-top:8px;
    max-width:210px;
    line-height:1.4;
  }

  /* ---------- Section link cards (hub page) ---------- */
  .link-grid{
    display:grid;
    grid-template-columns:repeat(auto-fill,minmax(220px,1fr));
    gap:16px;
    max-width:1180px;
    margin:40px auto 0;
    padding:0 28px;
  }
  .link-card{
    display:flex;
    flex-direction:column;
    gap:6px;
    padding:22px 20px;
    border:1px solid var(--line);
    border-left:3px solid var(--teal);
    border-radius:8px;
    background:var(--card);
    transition:border-color .2s ease, transform .2s ease, background .2s ease;
  }
  .link-card:hover{
    border-color:var(--gold);
    border-left-color:var(--gold);
    background:#181f2c;
    transform:translateY(-2px);
  }
  .link-card .lc-title{
    font-family:'Bebas Neue',sans-serif;
    font-size:1.7rem;
    letter-spacing:.02em;
  }
  .link-card .lc-desc{
    font-size:.82rem;
    color:var(--dim);
    line-height:1.45;
  }
  .link-card .lc-count{
    margin-top:6px;
    font-family:'DM Mono',monospace;
    font-size:.64rem;
    letter-spacing:.12em;
    text-transform:uppercase;
    color:var(--dim2);
  }

  /* ---------- Notes panel ---------- */
  .notes{
    max-width:1180px;
    margin:0 auto;
    padding:8px 28px 0;
  }
  .notes .box{
    border:1px solid var(--line);
    border-left:3px solid var(--teal);
    background:var(--card);
    border-radius:6px;
    padding:18px 20px;
    font-size:.86rem;
    line-height:1.6;
    color:var(--dim);
  }
  .notes .box b{color:var(--text);}
  .notes .box .tag2{
    font-family:'DM Mono',monospace;
    font-size:.62rem;
    letter-spacing:.16em;
    text-transform:uppercase;
    color:var(--teal);
    display:block;
    margin-bottom:8px;
  }

  /* ---------- FOOTER ---------- */
  footer{
    margin-top:60px;
    padding:36px 28px 60px;
    border-top:1px solid var(--line);
    display:flex;
    flex-direction:column;
    align-items:center;
    gap:8px;
    text-align:center;
  }
  footer .mark{
    font-family:'Bebas Neue',sans-serif;
    font-size:1.1rem;
    letter-spacing:.08em;
    color:var(--dim);
  }
  footer .mark b{color:var(--gold);}
  footer .tagline{
    font-family:'DM Mono',monospace;
    font-size:.66rem;
    letter-spacing:.12em;
    text-transform:uppercase;
    color:var(--dim2);
  }

  @media (max-width:560px){
    .section{padding:28px 18px 16px;}
    .section-nav{gap:2px;padding:10px;}
    .section-nav a{padding:7px 10px;font-size:.64rem;}
    .page-header{padding:20px 18px 14px;}
  }
  @media (prefers-reduced-motion:reduce){
    *{animation:none !important; transition:none !important;}
  }
"""

# ---------------------------------------------------------------------------
# SHARED SEARCH ENGINE (chalk-search.js) -- identical for both teams
# ---------------------------------------------------------------------------
CHALK_SEARCH_JS = """/* ChalkTalk shared search widget.
   Expects window.CHALK_PLAYS = [{id,label,hint,section,sub,href}, ...]
   set by a page-specific *-plays.js file loaded before this one. */
(function(){
  function escapeHtml(s){
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function highlight(text, query){
    var idx = text.toLowerCase().indexOf(query.toLowerCase());
    if(idx === -1) return escapeHtml(text);
    return escapeHtml(text.slice(0,idx)) + '<mark>' + escapeHtml(text.slice(idx, idx+query.length)) + '</mark>' + escapeHtml(text.slice(idx+query.length));
  }

  function initChalkSearch(inputId, resultsId){
    var input = document.getElementById(inputId);
    var results = document.getElementById(resultsId);
    var plays = window.CHALK_PLAYS || [];
    if(!input || !results) return;

    var activeIndex = -1;
    var currentMatches = [];

    function search(query){
      var q = query.trim().toLowerCase();
      if(!q) return [];
      return plays.filter(function(p){
        return p.label.toLowerCase().indexOf(q) !== -1 ||
               (p.hint && p.hint.toLowerCase().indexOf(q) !== -1) ||
               p.section.toLowerCase().indexOf(q) !== -1 ||
               (p.sub && p.sub.toLowerCase().indexOf(q) !== -1);
      });
    }

    function render(matches, query){
      results.innerHTML = '';
      if(!query){ results.classList.remove('open'); return; }
      if(matches.length === 0){
        results.innerHTML = '<div class="search-empty">No matches for &quot;' + escapeHtml(query) + '&quot;. Nothing has been built yet, or try a different term.</div>';
        results.classList.add('open');
        return;
      }
      matches.slice(0,8).forEach(function(m, i){
        var row = document.createElement('a');
        row.href = m.href;
        row.className = 'search-row' + (i === activeIndex ? ' active' : '');
        row.innerHTML = '<span class="sr-label">' + highlight(m.label, query) + '</span><span class="sr-path">' + escapeHtml(m.section) + (m.sub ? ' &rsaquo; ' + escapeHtml(m.sub) : '') + '</span>';
        results.appendChild(row);
      });
      results.classList.add('open');
    }

    input.addEventListener('input', function(){
      activeIndex = -1;
      currentMatches = search(input.value);
      render(currentMatches, input.value.trim());
    });

    input.addEventListener('keydown', function(e){
      if(!results.classList.contains('open')) return;
      var rows = results.querySelectorAll('.search-row');
      if(e.key === 'ArrowDown'){
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, rows.length - 1);
        rows.forEach(function(r){ r.classList.remove('active'); });
        if(rows[activeIndex]) rows[activeIndex].classList.add('active');
      } else if(e.key === 'ArrowUp'){
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
        rows.forEach(function(r){ r.classList.remove('active'); });
        if(rows[activeIndex]) rows[activeIndex].classList.add('active');
      } else if(e.key === 'Enter'){
        e.preventDefault();
        if(activeIndex >= 0 && rows[activeIndex]){
          window.location.href = rows[activeIndex].getAttribute('href');
        } else if(currentMatches[0]){
          window.location.href = currentMatches[0].href;
        }
      } else if(e.key === 'Escape'){
        results.classList.remove('open');
        input.blur();
      }
    });

    document.addEventListener('click', function(e){
      if(e.target !== input && !results.contains(e.target)){
        results.classList.remove('open');
      }
    });
  }

  window.initChalkSearch = initChalkSearch;

  document.addEventListener('DOMContentLoaded', function(){
    if(window.location.hash){
      var el = document.querySelector(window.location.hash);
      if(el){
        el.scrollIntoView({behavior:'smooth', block:'center'});
        el.classList.add('flash');
        setTimeout(function(){ el.classList.remove('flash'); }, 2200);
      }
    }
  });
})();
"""

# ---------------------------------------------------------------------------
# PLACEHOLDER PLAY DATA (ghost cards, shown until Intake Mode fills them in)
# ---------------------------------------------------------------------------
SECTIONS = ["offense", "defense", "slob", "blob", "special"]
SECTION_LABEL = {
    "offense": "Offense", "defense": "Defense",
    "slob": "SLOB", "blob": "BLOB", "special": "Specials",
}
SECTION_DESC = {
    "offense": "Half-Court Sets &amp; Coverages",
    "defense": "Coverages &amp; Principles",
    "slob": "Sideline Out Of Bounds",
    "blob": "Baseline Out Of Bounds",
    "special": "ATOs, Press-Break &amp; End-Game",
}
LINK_DESC = {
    "offense": "Man, zone, and press-break sets.",
    "defense": "Man, zone, and press coverages.",
    "slob": "Sideline inbounds calls.",
    "blob": "Baseline inbounds calls.",
    "special": "ATO, need-a-3, protect-the-lead.",
}

# team_key -> custom ghost-card copy. Any slug not listed here (which is
# every brand-new program created through /admin.html) falls through to
# the generic set below -- same content, just not team-flavored yet.
CUSTOM_TEAM_DATA = {}


def _generic_team_data():
    offense = {
        "Man": [
            ("o-man-ballscreen", "Ball-Screen Set", "Pick-and-roll entries, downhill reads, pop/short-roll counters."),
            ("o-man-motion", "Motion / Spacing Set", "5-out or 4-out spacing rules, drive-and-kick, relocate reads."),
            ("o-man-quick", "Quick Hitter", "Numbered call for a direct entry into a primary scoring option."),
            ("o-man-transition", "Transition Rule", "Push-ahead lanes, trailer spacing, early offense reads."),
        ],
        "Zone": [
            ("o-zone-overload", "Zone Attack &mdash; Overload", "Overload one side of a 2-3 or 3-2 zone to collapse a gap."),
            ("o-zone-highlow", "Zone Attack &mdash; High-Low", "Two-post high-low read against a zone's back line."),
            ("o-zone-gapskip", "Zone Attack &mdash; Gap/Skip", "Find seams and skip passes to shooters before the zone rotates."),
        ],
        "Press Break": [
            ("o-pb-man", "Man Press Break", "Outlet and advance rules against man-to-man full-court pressure."),
            ("o-pb-zone", "Zone Press Break", "Structured spacing to beat a 1-2-1-1 or 2-2-1 zone trap."),
        ],
    }
    defense = {
        "Man": [
            ("d-man-base", "Man Defense Set", "Base man principles, help-side rotations, closeouts."),
            ("d-man-coverage", "Ball-Screen Coverage", "Show, drop, or switch coverage rules for on-ball screens."),
            ("d-man-switch", "Switching Rule", "Man-to-man switching triggers and mismatch-hunting counters."),
        ],
        "Zone": [
            ("d-zone-23", "2-3 Zone", "Base 2-3 shell, rotations, and gap-help rules."),
            ("d-zone-32", "3-2 Zone", "Perimeter-heavy zone look to pressure the three-point line."),
            ("d-zone-matchup", "Matchup Zone", "Man principles inside a zone shell &mdash; assignment rules by area."),
        ],
        "Press": [
            ("d-press-full", "Full-Court Press", "Trap points, rotation, and containment for a full-court man or zone press."),
            ("d-press-34", "Three-Quarter Press", "Pressure applied from the frontcourt sideline in."),
            ("d-press-trap", "Half-Court Trap", "Change-of-pace trap triggered off a sideline or corner catch."),
        ],
    }
    slob = [
        ("slob-play", "SLOB Play", "First sideline call &mdash; screen action to spring the primary option."),
        ("slob-counter", "SLOB Counter", "Direct-entry variation for when the first look is scouted."),
    ]
    blob = [
        ("blob-play", "BLOB Play", "Staggered screen action off the baseline for a shooter or rim finish."),
        ("blob-special", "BLOB Special", "Late-game or under-one-second call."),
    ]
    special = [
        ("sp-ato", "ATO Play", "After-timeout call drawn up for a specific look or mismatch."),
        ("sp-need3", "Need-a-3 Set", "Late-clock, must-score-from-three entry."),
        ("sp-lead", "Protect-the-Lead Plan", "Clock management, foul-to-give rules, closing lineup."),
    ]
    return {"offense": offense, "defense": defense, "slob": slob, "blob": blob, "special": special}


def team_data(team_key):
    if team_key in CUSTOM_TEAM_DATA:
        return CUSTOM_TEAM_DATA[team_key]
    return _generic_team_data()


def render_ghost_card(item_id, label, hint):
    return ('      <a class="card ghost" id="{id}" href="#" onclick="return false;">\n'
            '        <span class="plus">+</span>\n'
            '        <span class="ghost-label">{label}</span>\n'
            '        <span class="ghost-hint">{hint}</span>\n'
            '      </a>\n').format(id=item_id, label=label, hint=hint)


def render_flat_section(items):
    out = '    <div class="grid">\n'
    for iid, label, hint in items:
        out += render_ghost_card(iid, label, hint)
    out += '    </div>\n'
    return out


def render_grouped_section(groups):
    out = ""
    for sub_name, items in groups.items():
        out += '    <div class="subhead">{0}</div>\n'.format(sub_name)
        out += '    <div class="grid">\n'
        for iid, label, hint in items:
            out += render_ghost_card(iid, label, hint)
        out += '    </div>\n'
    return out


def build_plays_js(team_key, data):
    prefix = team_key
    entries = []

    def add_flat(section_key, items):
        label_section = SECTION_LABEL[section_key]
        href_page = "{0}-{1}.html".format(prefix, section_key)
        for iid, label, hint in items:
            plain_label = label.replace("&mdash;", "-")
            entries.append((iid, plain_label, hint.replace("&mdash;", "-").replace("&rsquo;", "'"), label_section, "", href_page))

    def add_grouped(section_key, groups):
        label_section = SECTION_LABEL[section_key]
        href_page = "{0}-{1}.html".format(prefix, section_key)
        for sub_name, items in groups.items():
            for iid, label, hint in items:
                plain_label = label.replace("&mdash;", "-")
                entries.append((iid, plain_label, hint.replace("&mdash;", "-").replace("&rsquo;", "'"), label_section, sub_name, href_page))

    add_grouped("offense", data["offense"])
    add_grouped("defense", data["defense"])
    add_flat("slob", data["slob"])
    add_flat("blob", data["blob"])
    add_flat("special", data["special"])

    lines = ["window.CHALK_PLAYS = ["]
    for iid, label, hint, section, sub, href in entries:
        lines.append(
            "  {id:%r, label:%r, hint:%r, section:%r, sub:%r, href:%r}," % (
                iid, label, hint, section, sub, "{0}#{1}".format(href, iid)
            )
        )
    lines.append("];")
    return "\n".join(lines) + "\n"


def page_shell(team, active_section, body_html, plays_js_text, extra_head=""):
    prefix = team["file_prefix"]

    return """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title} &mdash; ChalkTalk Playbook</title>
<style>
:root{{ --accent-glow:{glow}; --accent-crest:{crest_bg}; }}
{css}
</style>
{extra_head}
<script>
{plays_js}
</script>
<script>
{search_js}
</script>
</head>
<body>
{body}
<footer>
  <div class="mark"><b>CHALK</b>TALK</div>
  <div class="tagline">{tagline} &nbsp;&middot;&nbsp; Coach-Built Playbooks</div>
</footer>
</body>
</html>
""".format(
        title=team["title"], glow=team["accent_glow"], crest_bg=team["accent_crest"],
        css=BASE_CSS, extra_head=extra_head, body=body_html,
        prefix=prefix, tagline=team["tagline"],
        plays_js=plays_js_text, search_js=CHALK_SEARCH_JS,
    )


def load_hero_visual(team):
    """Returns (hero_visual_html, photo_credit_html). Never raises -- a
    "photo" program whose hero_photo_file isn't actually in ASSET_DIR yet
    (true for any program created through the form until someone uploads
    a real photo) quietly falls back to generated art instead of failing
    the whole build."""
    if team.get("hero_mode") == "photo" and team.get("hero_photo_file"):
        try:
            data_uri = load_photo_data_uri(team["hero_photo_file"])
            hero_visual = '<div class="hero-photo"><img src="{0}" alt="{1}"></div>'.format(
                data_uri, team.get("hero_photo_alt", team.get("title", ""))
            )
            return hero_visual, team.get("hero_photo_credit", "")
        except OSError as exc:
            print(
                "WARNING: {0}: hero photo '{1}' not found ({2}) -- falling back to generated art".format(
                    team.get("slug", team.get("file_prefix")), team["hero_photo_file"], exc
                ),
                file=sys.stderr,
            )

    art = team.get("hero_art") or generic_hero_art(team["accent_glow"], team["accent_crest"])
    return '<div class="hero-art">{0}</div>'.format(art), ""


def build_hub_page(team, data, plays_js_text):
    prefix = team["file_prefix"]

    counts = {
        "offense": sum(len(v) for v in data["offense"].values()),
        "defense": sum(len(v) for v in data["defense"].values()),
        "slob": len(data["slob"]),
        "blob": len(data["blob"]),
        "special": len(data["special"]),
    }

    link_cards = ""
    for s in SECTIONS:
        link_cards += (
            '  <a class="link-card" href="{p}-{s}.html">\n'
            '    <div class="lc-title">{label}</div>\n'
            '    <div class="lc-desc">{desc}</div>\n'
            '    <div class="lc-count">0 of {count} built</div>\n'
            '  </a>\n'
        ).format(p=prefix, s=s, label=SECTION_LABEL[s], desc=LINK_DESC[s], count=counts[s])

    hero_visual, photo_credit_html = load_hero_visual(team)

    coach_line_html = ""
    if team.get("coach_line"):
        coach_line_html = '<div class="coach-line">{0}</div>'.format(team["coach_line"])

    beta_pill_html = ""
    if team.get("beta_status") == "beta":
        beta_pill_html = '<div class="beta-pill">Beta Program</div>'

    body = """
  <div class="hero">
    {hero_visual}
    <div class="hero-tex"></div>
    <div class="hero-fade"></div>
    <div class="photo-credit">{hero_photo_credit}</div>
    <div class="hero-inner">
      <div class="crest">{crest_html}</div>
      <div class="team-name">{team_name}</div>
      <div class="team-sub">{team_sub}</div>
      <div class="hero-line">{hero_line}</div>
      <div class="sign-accent"><i></i>{sign_accent}</div>
      {coach_line_html}
      {beta_pill_html}

      <div class="search-wrap">
        <input type="text" id="chalkSearch" placeholder="Search plays, sets, coverages..." autocomplete="off">
        <div class="search-results" id="chalkSearchResults"></div>
      </div>
    </div>
  </div>

  <div class="notes">
    <div class="box">
      <span class="tag2">Skeleton Status</span>
      {notes_text}
    </div>
  </div>

  <div class="link-grid">
{link_cards}  </div>

  <script>
    initChalkSearch('chalkSearch', 'chalkSearchResults');
  </script>
""".format(
        crest_html=team["crest_html"], team_name=team["team_name"], team_sub=team["team_sub"],
        hero_line=team["hero_line"], sign_accent=team["sign_accent"], coach_line_html=coach_line_html,
        beta_pill_html=beta_pill_html,
        notes_text=team["notes_text"], link_cards=link_cards,
        hero_visual=hero_visual, hero_photo_credit=photo_credit_html,
    )
    return page_shell(team, None, body, plays_js_text)


def build_section_page(team, section_key, data, plays_js_text):
    prefix = team["file_prefix"]
    label = SECTION_LABEL[section_key]
    desc = SECTION_DESC[section_key]

    if section_key in ("offense", "defense"):
        content = render_grouped_section(data[section_key])
    else:
        content = render_flat_section(data[section_key])

    nav_links = ""
    for s in SECTIONS:
        cls = ' class="active"' if s == section_key else ""
        nav_links += '    <a href="{p}-{s}.html"{cls}>{lbl}</a>\n'.format(
            p=prefix, s=s, cls=cls, lbl=SECTION_LABEL[s]
        )

    body = """
  <nav class="section-nav">
{nav_links}  </nav>

  <div class="page-header">
    <a class="home-link" href="{prefix}-hub.html">&larr; Return to {title} Hub</a>
    <div class="page-title-row">
      <h1>{label}</h1>
      <div class="team-tag">{title}</div>
    </div>

    <div class="search-wrap" style="margin:18px 0 0;max-width:100%;">
      <input type="text" id="chalkSearch" placeholder="Search plays, sets, coverages..." autocomplete="off">
      <div class="search-results" id="chalkSearchResults"></div>
    </div>
  </div>

  <section class="section" id="{section_key}">
    <div class="section-head">
      <h2>{label}</h2>
      <p>{desc}</p>
    </div>
{content}  </section>

  <script>
    initChalkSearch('chalkSearch', 'chalkSearchResults');
  </script>
""".format(
        nav_links=nav_links, prefix=prefix, title=team["title"], label=label,
        desc=desc, section_key=section_key, content=content,
    )
    return page_shell(team, section_key, body, plays_js_text)


def main():
    if not TEAMS:
        print("WARNING: no programs loaded from {0} -- nothing to build".format(PROGRAMS_DIR), file=sys.stderr)

    os.makedirs(OUT, exist_ok=True)

    for team_key, team in TEAMS.items():
        data = team_data(team_key)
        prefix = team["file_prefix"]
        plays_js_text = build_plays_js(team_key, data)

        # standalone plays.js (kept for reference / real Vercel deployment reuse)
        with open(os.path.join(OUT, "{0}-plays.js".format(prefix)), "w", encoding="ascii") as f:
            f.write(plays_js_text)

        # hub -- self-contained, data + search engine inlined
        with open(os.path.join(OUT, "{0}-hub.html".format(prefix)), "w", encoding="ascii") as f:
            f.write(build_hub_page(team, data, plays_js_text))

        # section pages -- self-contained, data + search engine inlined
        for s in SECTIONS:
            with open(os.path.join(OUT, "{0}-{1}.html".format(prefix, s)), "w", encoding="ascii") as f:
                f.write(build_section_page(team, s, data, plays_js_text))

    # standalone shared search engine (kept for reference / real Vercel deployment reuse)
    with open(os.path.join(OUT, "chalk-search.js"), "w", encoding="ascii") as f:
        f.write(CHALK_SEARCH_JS)

    print("Done. Built {0} program(s) into {1}/".format(len(TEAMS), OUT))


if __name__ == "__main__":
    main()
