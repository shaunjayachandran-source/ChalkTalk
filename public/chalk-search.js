/* ChalkTalk shared search widget.
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
