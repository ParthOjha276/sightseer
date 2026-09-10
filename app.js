/*
 * app.js — network, validation, state machine, DOM.
 *
 * All judgement lives in engine.js. This file only decides what to show and
 * when. Five states share one panel: empty, loading, choose, error, results.
 */
(function () {
  'use strict';

  var GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
  var FORECAST = 'https://api.open-meteo.com/v1/forecast';

  var DAILY_FIELDS = [
    'temperature_2m_max', 'temperature_2m_min',
    'apparent_temperature_max', 'apparent_temperature_min',
    'precipitation_probability_max', 'precipitation_sum',
    'uv_index_max', 'wind_speed_10m_max',
    'sunrise', 'sunset'
  ].join(',');

  // Hourly feels-like is what lets the engine say which hours of a hot day are
  // still walkable. Same request, one more field.
  var HOURLY_FIELDS = ['precipitation_probability', 'apparent_temperature'].join(',');

  // Our own cap. The API reaches ~16 days; we stop at 14 so the last day of a
  // range is never at the ragged edge of the model's usefulness.
  var MAX_DAYS_AHEAD = 14;
  var MAX_TRIP_NIGHTS = 14;

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    form: $('search'), city: $('city'), start: $('start'), end: $('end'),
    go: $('go'), formError: $('formError'), panel: $('panel'), status: $('status'),
    empty: $('stateEmpty'), loading: $('stateLoading'), loadingMsg: $('loadingMsg'),
    skeletonGrid: $('skeletonGrid'),
    choose: $('stateChoose'), chooseSub: $('chooseSub'), choices: $('choices'),
    chooseCancel: $('chooseCancel'),
    error: $('stateError'), errorTitle: $('errorTitle'), errorBody: $('errorBody'),
    retry: $('retry'),
    results: $('stateResults'), summaryPlace: $('summaryPlace'),
    summaryLine: $('summaryLine'), summaryBest: $('summaryBest'),
    tripStrip: $('tripStrip'),
    days: $('days'), packList: $('packList'), packBase: $('packBase'),
    priority: $('priority'), thresholds: $('thresholds')
  };

  var inflight = null;      // AbortController for the current request chain
  var lastQuery = null;     // city + dates, for the retry button
  var chosenPlace = null;   // set once a place is resolved, so retry resumes there
                            // instead of walking the user back through the picker
  var recovery = null;      // what the error state's button should actually do
  var flagTimer = null;

  /* ── date helpers ──────────────────────────────────────────────── */

  function iso(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function daysBetween(a, b) {
    return Math.round((Date.parse(b + 'T00:00:00') - Date.parse(a + 'T00:00:00')) / 86400000);
  }

  /* ── state switching ───────────────────────────────────────────── */

  // The panel swaps entire screens, so it cannot be a live region — a screen
  // reader would read every card aloud. One short line carries the change.
  function announce(msg) {
    els.status.textContent = '';
    if (msg) els.status.textContent = msg;
  }

  function show(which) {
    [els.empty, els.loading, els.choose, els.error, els.results]
      .forEach(function (n) { n.hidden = true; });
    which.hidden = false;
    els.panel.setAttribute('aria-busy', which === els.loading ? 'true' : 'false');
    els.go.disabled = (which === els.loading);
  }

  // Show as many placeholder cards as the trip has days, so the skeleton is not
  // quietly promising four.
  function sizeSkeleton(nights) {
    var n = Math.max(1, Math.min(6, (nights || 0) + 1));
    els.skeletonGrid.innerHTML = '';
    while (n--) {
      var d = document.createElement('div');
      d.className = 'skeleton-card';
      els.skeletonGrid.appendChild(d);
    }
  }

  // A misspelled city fails identically every time it is retried, so the button
  // has to offer the only move that can work rather than a dead end.
  function showError(title, body, fix) {
    els.errorTitle.textContent = title;
    els.errorBody.textContent = body;
    recovery = fix || null;
    els.retry.textContent = recovery ? recovery.label : 'Try again';
    show(els.error);
  }

  var EDIT_CITY = { label: 'Change the city', edit: true };

  function setFormError(msg) {
    if (!msg) { els.formError.hidden = true; els.formError.textContent = ''; return; }
    els.formError.textContent = msg;
    els.formError.hidden = false;
  }

  /* ── validation ────────────────────────────────────────────────── */

  function validate() {
    var city = els.city.value.trim();
    var start = els.start.value;
    var end = els.end.value;
    var today = iso(new Date());
    var limit = iso(addDays(new Date(), MAX_DAYS_AHEAD));

    if (city.length < 2) return { error: 'Enter a city name, at least two characters.' };
    if (!/[a-zA-ZÀ-ɏЀ-ӿऀ-ॿ]/.test(city)) {
      return { error: 'That does not look like a city name.' };
    }
    if (!start || !end) return { error: 'Pick both a first and a last day.' };
    if (daysBetween(today, start) < 0) return { error: 'The first day is in the past. Pick today or later.' };
    if (daysBetween(start, end) < 0) return { error: 'The last day is before the first day.' };
    if (daysBetween(today, end) > MAX_DAYS_AHEAD) {
      return { error: 'Forecasts only run ' + MAX_DAYS_AHEAD +
        ' days ahead. The latest date available is ' + limit + '.' };
    }
    if (daysBetween(start, end) > MAX_TRIP_NIGHTS) {
      return { error: 'Keep the range to ' + MAX_TRIP_NIGHTS + ' days or fewer.' };
    }
    return { city: city, start: start, end: end };
  }

  /* ── network ───────────────────────────────────────────────────── */

  function getJSON(url, signal) {
    return fetch(url, { signal: signal }).then(function (r) {
      if (!r.ok) {
        var e = new Error('HTTP ' + r.status);
        e.status = r.status;
        throw e;
      }
      return r.json();
    });
  }

  function geocode(city, signal) {
    // encodeURIComponent is what keeps "New Delhi" from breaking the request.
    var url = GEOCODE + '?name=' + encodeURIComponent(city) +
      '&count=5&language=en&format=json';
    return getJSON(url, signal).then(function (j) { return j.results || []; });
  }

  function forecast(place, start, end, signal) {
    var url = FORECAST +
      '?latitude=' + encodeURIComponent(place.latitude) +
      '&longitude=' + encodeURIComponent(place.longitude) +
      '&daily=' + DAILY_FIELDS +
      '&hourly=' + HOURLY_FIELDS +
      '&timezone=auto' +
      '&start_date=' + encodeURIComponent(start) +
      '&end_date=' + encodeURIComponent(end);
    return getJSON(url, signal);
  }

  /* ── rendering ─────────────────────────────────────────────────── */

  function placeLabel(p) {
    return [p.name, p.admin1, p.country].filter(Boolean).join(', ');
  }

  // Open-Meteo will hand back two places with the same name, region and country.
  // "We never silently pick" is worth nothing if the user cannot tell the options
  // apart, so each row gets the shortest label that is unique in this set — and
  // coordinates only where even the full administrative chain collides.
  function adminChain(p) {
    var seen = {}, out = [];
    [p.admin3, p.admin2, p.admin1, p.country].forEach(function (v) {
      if (!v || v === p.name || seen[v]) return;
      seen[v] = true;
      out.push(v);
    });
    return out;                       // most specific first
  }

  function labelAt(chain, depth) {
    return chain.slice(Math.max(0, chain.length - 2 - depth)).join(', ');
  }

  function coordLabel(p) {
    return Math.abs(p.latitude).toFixed(2) + '\u00B0' + (p.latitude >= 0 ? 'N' : 'S') + ' ' +
           Math.abs(p.longitude).toFixed(2) + '\u00B0' + (p.longitude >= 0 ? 'E' : 'W');
  }

  function describe(matches) {
    var chains = matches.map(adminChain);
    var maxDepth = chains.reduce(function (m, c) { return Math.max(m, c.length - 2); }, 0);

    function key(i, depth) { return matches[i].name + '\u0000' + labelAt(chains[i], depth); }

    // Depth is decided per row, not for the whole list: only the rows that
    // actually collide pay for the extra administrative level.
    return matches.map(function (m, i) {
      for (var d = 0; d <= maxDepth; d++) {
        var k = key(i, d), clash = false;
        for (var j = 0; j < matches.length && !clash; j++) {
          if (j !== i && key(j, d) === k) clash = true;
        }
        if (!clash) return { where: labelAt(chains[i], d), coords: null };
      }
      return { where: labelAt(chains[i], maxDepth), coords: coordLabel(m) };
    });
  }

  function population(p) {
    if (!p.population) return '';
    if (p.population >= 1e6) return (p.population / 1e6).toFixed(1).replace(/\.0$/, '') + 'M people';
    if (p.population >= 1e3) return Math.round(p.population / 1e3) + 'k people';
    return p.population + ' people';
  }

  function renderChoices(city, matches) {
    els.chooseSub.textContent = matches.length + ' places match "' + city +
      '". Picking the wrong one would give you the wrong forecast, so we are not guessing.';
    els.choices.innerHTML = '';

    var ranked = matches.slice()
      .sort(function (a, b) { return (b.population || 0) - (a.population || 0); });
    var labels = describe(ranked);

    ranked.forEach(function (p, i) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice';

      var left = document.createElement('span');
      var name = document.createElement('span');
      name.className = 'choice-name';
      name.textContent = p.name;
      var where = document.createElement('span');
      where.className = 'choice-where';
      where.textContent = labels[i].where;
      if (labels[i].coords) {
        var co = document.createElement('span');
        co.className = 'choice-coords';
        co.textContent = labels[i].coords;
        where.appendChild(document.createTextNode(' \u00B7 '));
        where.appendChild(co);
      }
      left.appendChild(name); left.appendChild(where);

      btn.appendChild(left);

      var popText = population(p);
      if (popText) {
        var pop = document.createElement('span');
        pop.className = 'choice-pop';
        pop.textContent = popText;
        btn.appendChild(pop);
      }

      btn.addEventListener('click', function () { runForecast(p); });
      li.appendChild(btn);
      els.choices.appendChild(li);
    });
    announce(matches.length + ' places match ' + city + '. Choose one.');
    show(els.choose);
    var first = els.choices.querySelector('button');
    if (first) first.focus();
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function icon() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'plan-icon');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    Array.prototype.forEach.call(arguments, function (d) {
      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }

  function statPart(label, value) {
    if (value === null || value === undefined) return null;
    var span = document.createElement('span');
    var b = document.createElement('b');
    b.textContent = value;
    span.textContent = label + ' ';
    span.appendChild(b);
    return span;
  }

  function renderDay(d) {
    var card = document.createElement('article');
    card.className = 'day sev-' + d.severity;
    card.tabIndex = -1;

    var head = document.createElement('div');
    head.className = 'day-head';
    var date = document.createElement('span');
    date.className = 'day-date';
    date.textContent = d.label;
    var badge = document.createElement('span');
    badge.className = 'day-badge';
    badge.textContent = ['Good', 'Plan around it', 'Difficult'][d.severity];
    head.appendChild(date); head.appendChild(badge);

    var verdict = document.createElement('p');
    verdict.className = 'day-verdict';
    verdict.textContent = d.headline;

    card.appendChild(head);
    card.appendChild(verdict);

    if (d.plan) {
      var plan = document.createElement('p');
      plan.className = 'day-plan';
      plan.appendChild(icon('M8 4.2v4l2.6 1.6', 'M8 1.6a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8z'));
      plan.appendChild(document.createTextNode(d.plan));
      card.appendChild(plan);
    }

    if (d.chips.length) {
      var chips = document.createElement('div');
      chips.className = 'day-chips';
      var also = document.createElement('span');
      also.className = 'chips-label';
      also.textContent = 'Also';
      chips.appendChild(also);
      d.chips.forEach(function (c) {
        var el = document.createElement('span');
        el.className = 'chip lv-' + c.level;
        el.textContent = c.label;
        chips.appendChild(el);
      });
      card.appendChild(chips);
    }

    var s = d.stats;
    var stats = document.createElement('div');
    stats.className = 'day-stats';
    var parts = [];
    if (s.high !== null && s.low !== null) {
      var t = s.high + '° / ' + s.low + '°';
      if (s.feelsHigh !== null && s.feelsHigh !== s.high) t += ' (feels ' + s.feelsHigh + '°)';
      parts.push(statPart('Temp', t));
    }
    if (s.rainProb !== null) {
      parts.push(statPart('Rain', s.rainProb + '%' +
        (s.rainSum ? ' · ' + s.rainSum + 'mm' : '')));
    }
    if (s.uv !== null) parts.push(statPart('UV', String(s.uv)));
    if (s.wind !== null) parts.push(statPart('Wind', s.wind + ' km/h'));
    parts.filter(Boolean).forEach(function (p) { stats.appendChild(p); });
    if (stats.childNodes.length) card.appendChild(stats);

    return card;
  }

  function renderPacking(list, target) {
    target.innerHTML = '';
    list.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'pack-item';
      var name = document.createElement('span');
      name.className = 'pack-name';
      name.textContent = p.item;
      var why = document.createElement('span');
      why.className = 'pack-why';
      why.textContent = p.why;
      li.appendChild(name); li.appendChild(why);
      target.appendChild(li);
    });
  }

  function renderMethod(result) {
    els.priority.textContent = result.priority
      .map(function (k) { return result.thresholds[k].label; })
      .join('  →  ');

    var tbody = els.thresholds.querySelector('tbody');
    tbody.innerHTML = '';
    result.priority.forEach(function (k) {
      var t = result.thresholds[k];
      var tr = document.createElement('tr');
      [t.label, t.caution, t.severe].forEach(function (txt) {
        var td = document.createElement('td');
        td.textContent = txt;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  var VERDICT_WORD = ['Good', 'Plan around it', 'Difficult'];

  // A ten-day trip is ten cards. The strip answers "how is this trip looking"
  // in one glance and doubles as the way into any single day.
  function renderStrip(days) {
    els.tripStrip.innerHTML = '';
    if (days.length < 3) { els.tripStrip.hidden = true; return; }
    days.forEach(function (d, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'strip-day sev-' + d.severity;
      b.textContent = String(parseInt(d.date.slice(8), 10));
      b.title = d.label + ': ' + VERDICT_WORD[d.severity].toLowerCase();
      b.setAttribute('aria-label',
        d.label + ', ' + VERDICT_WORD[d.severity].toLowerCase() + '. Jump to this day.');
      b.addEventListener('click', function () { jumpToDay(i); });
      els.tripStrip.appendChild(b);
    });
    els.tripStrip.hidden = false;
  }

  function jumpToDay(i) {
    var card = els.days.children[i];
    if (!card) return;
    // Deliberately not a smooth scroll. Animated scrolling is the part of this
    // that silently does nothing when a browser declines to animate, and a jump
    // that goes nowhere is worse than one that arrives immediately. The ring
    // below is what confirms where you landed.
    card.focus({ preventScroll: true });
    card.scrollIntoView({ behavior: 'auto', block: 'center' });
    clearTimeout(flagTimer);
    Array.prototype.forEach.call(els.days.children, function (c) {
      c.classList.remove('is-target');
    });
    card.classList.add('is-target');
    flagTimer = setTimeout(function () { card.classList.remove('is-target'); }, 1800);
  }

  // The summary names a day; naming it is not much use unless you can get to it.
  function bestLine(prefix, label, index) {
    els.summaryBest.textContent = prefix + ' ';
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'jump-link';
    b.textContent = label;
    b.addEventListener('click', function () { jumpToDay(index); });
    els.summaryBest.appendChild(b);
    els.summaryBest.appendChild(document.createTextNode('.'));
    els.summaryBest.hidden = false;
  }

  function renderResults(place, result) {
    els.summaryPlace.textContent = placeLabel(place);
    els.summaryLine.textContent = result.summary.line;

    var best = result.summary.best;
    var counts = result.summary.counts;
    var bestIndex = best ? result.days.indexOf(best) : -1;
    if (best && bestIndex >= 0 && counts.total > 1 && counts.good > 0) {
      bestLine('Best day looks like', best.label, bestIndex);
    } else if (best && bestIndex >= 0 && counts.total > 1) {
      bestLine('Your easiest day is', best.label, bestIndex);
    } else {
      els.summaryBest.hidden = true;
    }

    els.days.innerHTML = '';
    result.days.forEach(function (d) { els.days.appendChild(renderDay(d)); });

    renderStrip(result.days);
    renderPacking(result.packing.conditional, els.packList);
    renderPacking(result.packing.base, els.packBase);
    renderMethod(result);

    show(els.results);
    stagger();
    announce(result.days.length + ' day forecast for ' + placeLabel(place) + '. ' +
      result.summary.line);
  }

  // The one authored moment: results rising into place, in reading order.
  // Re-running a search has to replay it, so the class is cycled with a reflow
  // between — otherwise persistent nodes keep their finished animation.
  function stagger() {
    var i = 0;
    // Cap the stagger so a fourteen-day trip does not take a second to arrive.
    var step = function (el) { el.style.setProperty('--i', String(Math.min(i++, 9))); };
    step(els.results.querySelector('.summary'));
    Array.prototype.forEach.call(els.days.children, step);
    step(els.results.querySelector('.packing'));
    step(els.results.querySelector('.method'));

    els.results.classList.remove('is-in');
    void els.results.offsetWidth;
    els.results.classList.add('is-in');
  }

  /* ── flow ──────────────────────────────────────────────────────── */

  function fail(err) {
    if (err && err.name === 'AbortError') return;   // superseded by a newer search
    recovery = null;
    if (!navigator.onLine) {
      showError('You are offline',
        'This app reads live forecast data, so it needs a connection. Reconnect and try again.');
      return;
    }
    if (err && err.status === 429) {
      showError('Too many requests',
        'The free forecast service is rate-limiting us. Wait a moment and try again.');
      return;
    }
    showError('The forecast service did not respond',
      'Open-Meteo could not be reached' +
      (err && err.message ? ' (' + err.message + ')' : '') +
      '. This is usually temporary, so try again in a moment.');
  }

  function runForecast(place) {
    if (inflight) inflight.abort();
    inflight = new AbortController();
    var signal = inflight.signal;

    chosenPlace = place;
    els.loadingMsg.textContent = 'Reading the forecast for ' + place.name + '…';
    announce(els.loadingMsg.textContent);
    sizeSkeleton(daysBetween(lastQuery.start, lastQuery.end));
    show(els.loading);

    forecast(place, lastQuery.start, lastQuery.end, signal)
      .then(function (payload) {
        var result = Engine.analyse(payload);
        if (!result) {
          showError('No forecast for those dates',
            'The service returned nothing for ' + placeLabel(place) +
            ' between ' + lastQuery.start + ' and ' + lastQuery.end +
            '. Try a shorter range closer to today.');
          return;
        }
        renderResults(place, result);
      })
      .catch(fail);
  }

  function runSearch(e) {
    if (e) e.preventDefault();
    setFormError(null);

    var q = validate();
    if (q.error) {
      setFormError(q.error);
      els.city.focus();
      return;
    }
    lastQuery = q;
    chosenPlace = null;

    if (inflight) inflight.abort();
    inflight = new AbortController();
    var signal = inflight.signal;

    els.loadingMsg.textContent = 'Finding ' + q.city + '…';
    announce(els.loadingMsg.textContent);
    sizeSkeleton(daysBetween(q.start, q.end));
    show(els.loading);

    geocode(q.city, signal)
      .then(function (matches) {
        if (!matches.length) {
          showError('No city called "' + q.city + '"',
            'Check the spelling, or try the English name. Some small towns are ' +
            'missing from the database, and the nearest larger city usually has ' +
            'the same weather.', EDIT_CITY);
          return;
        }
        // Ten places are called Springfield. We never silently pick one.
        if (matches.length > 1) { renderChoices(q.city, matches); return; }
        runForecast(matches[0]);
      })
      .catch(fail);
  }

  /* ── wiring ────────────────────────────────────────────────────── */

  function init() {
    var today = new Date();
    var todayIso = iso(today);
    var limitIso = iso(addDays(today, MAX_DAYS_AHEAD));

    [els.start, els.end].forEach(function (input) {
      input.min = todayIso;
      input.max = limitIso;
    });
    els.start.value = todayIso;
    els.end.value = iso(addDays(today, 4));

    // Keep the range coherent as the user changes either end.
    els.start.addEventListener('change', function () {
      if (els.start.value && els.end.value && daysBetween(els.start.value, els.end.value) < 0) {
        els.end.value = els.start.value;
      }
      els.end.min = els.start.value || todayIso;
      setFormError(null);
    });
    els.end.addEventListener('change', function () { setFormError(null); });
    els.city.addEventListener('input', function () { setFormError(null); });

    els.form.addEventListener('submit', runSearch);

    // A forecast that failed for a place the user already picked should retry
    // that place — not walk them back through the city picker.
    els.retry.addEventListener('click', function () {
      if (recovery && recovery.edit) {
        show(els.empty);
        els.city.focus();
        els.city.select();
        return;
      }
      if (chosenPlace && lastQuery) { runForecast(chosenPlace); return; }
      runSearch();
    });

    els.chooseCancel.addEventListener('click', function () {
      chosenPlace = null;
      announce(null);
      show(els.empty);
      els.city.focus();
      els.city.select();
    });

    show(els.empty);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
