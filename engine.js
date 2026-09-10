/*
 * engine.js: the judgement layer.
 *
 * Pure functions only. No DOM, no fetch. Everything here is deterministic:
 * give it the same forecast, it gives you the same verdict. That makes it
 * testable from Node (see test-fixtures.js) and keeps the reasoning readable
 * in one file.
 *
 * Audience decision: this app advises ONE person, the city sightseer. They get
 * between sights however they like, by taxi or metro or on foot, and see the
 * sights themselves by walking: 5-8 km across the day, in stretches between 9am
 * and 7pm, no specialist gear. Transport is not the product's concern. What
 * matters is that the sightseeing happens outdoors, in blocks, inside a
 * predictable window. Every threshold below is calibrated to that person and
 * nobody else.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------------------
   * 1. Configuration. Every number the app judges by, in one place.
   * ------------------------------------------------------------------ */

  var AUDIENCE =
    'Advice for the city sightseer: travel between sights however you like, ' +
    'see them on foot. 5-8 km a day, 9am to 7pm.';

  // The walking day. Weather outside this window matters much less to us.
  var ACTIVE_START = 9;   // 09:00
  var ACTIVE_END = 19;    // 19:00 (exclusive)

  // An hour counts as wet for a pedestrian at 50% probability, and as properly
  // wet at 70%. Same two marks as the daily rain thresholds, read hour by hour.
  var WET_HOUR_PROB = 50;
  var HEAVY_HOUR_PROB = 70;

  // If the wettest walking hour is below this, the rain is happening while
  // you are asleep or at dinner. We demote the day rather than warn about it.
  var OFF_HOURS_PROB = 40;

  // Feels-like bands, shared by the daily score and the hourly window so the
  // two never disagree about what counts as a problem.
  var HEAT_CAUTION = 32, HEAT_SEVERE = 38;
  var COLD_CAUTION = 8, COLD_SEVERE = 0;
  var WIND_CAUTION = 25, WIND_SEVERE = 40;
  var UV_CAUTION = 6, UV_SEVERE = 8;

  var THRESHOLDS = {
    rain: {
      label: 'Rain',
      caution: 'precipitation probability 40-70%, or 2-10 mm expected',
      severe: 'precipitation probability above 70%, or more than 10 mm'
    },
    heat: {
      label: 'Heat',
      caution: 'feels-like high of 32-38 °C',
      severe: 'feels-like high above 38 °C'
    },
    cold: {
      label: 'Cold',
      caution: 'feels-like low of 0-8 °C',
      severe: 'feels-like low below 0 °C'
    },
    wind: {
      label: 'Wind',
      caution: 'gusts of 25-40 km/h',
      severe: 'gusts above 40 km/h'
    },
    uv: {
      label: 'Sun',
      caution: 'UV index 6-8',
      severe: 'UV index above 8'
    }
  };

  /*
   * Priority order when several signals fire on the same day.
   *
   * Rain and thermal stress change WHETHER you go out. Wind and UV change WHAT
   * YOU WEAR. The single verdict sentence belongs to the signal that changes
   * the bigger decision; everything else drops to a secondary chip.
   */
  var PRIORITY = ['rain', 'heat', 'cold', 'wind', 'uv'];

  /* ---------------------------------------------------------------------
   * 2. Small helpers
   * ------------------------------------------------------------------ */

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  function round(v) {
    return v === null ? null : Math.round(v);
  }

  function formatHour(h) {
    var hh = ((h % 24) + 24) % 24;
    if (hh === 0) return '12am';
    if (hh === 12) return '12pm';
    return (hh < 12 ? hh + 'am' : (hh - 12) + 'pm');
  }

  // "2pm to 6pm" reads worse than "2 to 6pm" when the meridiem matches.
  function span(a, b) {
    var x = formatHour(a), y = formatHour(b);
    if (x.slice(-2) === y.slice(-2)) x = x.slice(0, -2);
    return x + ' to ' + y;
  }

  function clockFromIso(iso) {
    // "2026-09-06T06:12" -> "6:12am"
    if (!iso || iso.length < 16) return null;
    var h = parseInt(iso.slice(11, 13), 10);
    var m = iso.slice(14, 16);
    var suffix = h < 12 ? 'am' : 'pm';
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + m + suffix;
  }

  function hourFromIso(iso) {
    if (!iso || iso.length < 13) return null;
    var h = parseInt(iso.slice(11, 13), 10);
    return isFinite(h) ? h : null;
  }

  function prettyDate(iso) {
    var parts = iso.split('-');
    var d = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
    var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return days[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + months[d.getUTCMonth()];
  }

  /* ---------------------------------------------------------------------
   * 3. Normalise the API's columnar response into day rows
   * ------------------------------------------------------------------ */

  function normalise(payload) {
    var d = payload && payload.daily;
    if (!d || !Array.isArray(d.time)) return [];
    function at(key, i) {
      return d[key] && d[key][i] !== undefined ? num(d[key][i]) : null;
    }
    return d.time.map(function (date, i) {
      return {
        date: date,
        tMax: at('temperature_2m_max', i),
        tMin: at('temperature_2m_min', i),
        feelsMax: at('apparent_temperature_max', i),
        feelsMin: at('apparent_temperature_min', i),
        rainProb: at('precipitation_probability_max', i),
        rainSum: at('precipitation_sum', i),
        uv: at('uv_index_max', i),
        wind: at('wind_speed_10m_max', i),
        sunrise: d.sunrise ? d.sunrise[i] : null,
        sunset: d.sunset ? d.sunset[i] : null
      };
    });
  }

  // Pull one day's walking hours out of the hourly block.
  function hoursFor(hourly, date) {
    if (!hourly || !Array.isArray(hourly.time)) return [];
    var prob = hourly.precipitation_probability;
    var feels = hourly.apparent_temperature;
    var out = [];
    for (var i = 0; i < hourly.time.length; i++) {
      var t = hourly.time[i];
      if (t.slice(0, 10) !== date) continue;
      var h = hourFromIso(t);
      if (h === null || h < ACTIVE_START || h >= ACTIVE_END) continue;
      out.push({
        hour: h,
        prob: Array.isArray(prob) ? num(prob[i]) : null,
        feels: Array.isArray(feels) ? num(feels[i]) : null
      });
    }
    return out;
  }

  /* ---------------------------------------------------------------------
   * 4. Rain timing. The part that makes the advice actionable.
   *
   * We look at hourly probability inside the walking window only, and find the
   * longest run of wet hours. Three outcomes matter:
   *   a block  ("mainly 2-6pm")       you can plan around it
   *   all day  ("through most of it") you cannot
   *   off-hours                       the rain misses you entirely
   * ------------------------------------------------------------------ */

  function rainTiming(hourly, date) {
    var probs = hoursFor(hourly, date).filter(function (x) { return x.prob !== null; });
    if (!probs.length) return null;

    var activeMax = probs.reduce(function (m, x) { return Math.max(m, x.prob); }, 0);

    // Longest contiguous wet run
    var best = null, run = null;
    probs.forEach(function (x) {
      if (x.prob >= WET_HOUR_PROB) {
        if (run && run.end === x.hour - 1) run.end = x.hour;
        else run = { start: x.hour, end: x.hour };
        if (!best || (run.end - run.start) > (best.end - best.start)) best = run;
      } else {
        run = null;
      }
    });

    var activeHours = ACTIVE_END - ACTIVE_START;

    if (best && (best.end - best.start + 1) >= activeHours - 2) {
      return { kind: 'allday', phrase: 'through most of the day', activeMax: activeMax };
    }
    if (best) {
      return { kind: 'block', phrase: 'mainly ' + span(best.start, best.end + 1), activeMax: activeMax };
    }
    if (activeMax < OFF_HOURS_PROB) {
      return {
        kind: 'offhours',
        phrase: 'but almost all of it falls outside walking hours',
        activeMax: activeMax
      };
    }
    return { kind: 'scattered', phrase: 'on and off through the day', activeMax: activeMax };
  }

  /* ---------------------------------------------------------------------
   * 5. The walking window.
   *
   * The rain block above only produces a phrase. This inverts it: given the
   * hourly numbers and the daylight, hand back the hours that are actually
   * good, so the day reads as a plan rather than a warning. Heat and cold are
   * scored hour by hour against the same bands the daily score uses, which is
   * what lets a 39 °C afternoon close while its morning stays open.
   * ------------------------------------------------------------------ */

  // Only rain and thermal stress can close an hour, for the same reason they
  // win the headline: wind and UV change your kit, not your schedule.
  function hourCost(h) {
    var cost = 0, reason = null;
    if (h.prob !== null) {
      if (h.prob >= HEAVY_HOUR_PROB) { cost = 2; reason = 'rain'; }
      else if (h.prob >= WET_HOUR_PROB) { cost = 1; reason = 'rain'; }
    }
    if (h.feels !== null) {
      var hot = h.feels > HEAT_SEVERE ? 2 : h.feels >= HEAT_CAUTION ? 1 : 0;
      var cold = h.feels < COLD_SEVERE ? 2 : h.feels <= COLD_CAUTION ? 1 : 0;
      var thermal = Math.max(hot, cold);
      if (thermal > cost) { cost = thermal; reason = hot >= cold ? 'heat' : 'cold'; }
    }
    return { cost: cost, reason: reason };
  }

  function runsOf(hours, test) {
    var runs = [], run = null;
    hours.forEach(function (x) {
      if (test(x)) {
        if (run && run.end === x.hour - 1) { run.end = x.hour; run.reasons.push(x.reason); }
        else { run = { start: x.hour, end: x.hour, reasons: [x.reason] }; runs.push(run); }
      } else {
        run = null;
      }
    });
    // A run can start wet and end hot. Keep the whole tally so the caller can
    // prefer the signal the day is already being judged on, and fall back to
    // whichever one dominates the run.
    runs.forEach(function (r) {
      var tally = {}, best = null;
      r.reasons.forEach(function (k) {
        if (!k) return;
        tally[k] = (tally[k] || 0) + 1;
        if (!best || tally[k] > tally[best]) best = k;
      });
      r.tally = tally;
      r.reason = best;
      delete r.reasons;
    });
    return runs;
  }

  function longestRun(list) {
    return list.reduce(function (a, b) {
      return !a || (b.end - b.start) > (a.end - a.start) ? b : a;
    }, null);
  }

  function walkingWindow(hourly, day) {
    var raw = hoursFor(hourly, day.date);
    if (!raw.length) return null;

    // Daylight trims the window further at either end.
    var rise = hourFromIso(day.sunrise);
    var set = hourFromIso(day.sunset);
    var from = rise === null ? ACTIVE_START : Math.max(ACTIVE_START, rise);
    var to = set === null ? ACTIVE_END : Math.min(ACTIVE_END, set + 1);
    if (to - from < 2) return null;

    var hours = raw
      .filter(function (x) { return x.hour >= from && x.hour < to; })
      .map(function (x) {
        var c = hourCost(x);
        return { hour: x.hour, cost: c.cost, reason: c.reason };
      });
    if (!hours.length) return null;

    var open = runsOf(hours, function (x) { return x.cost === 0; });
    var soft = runsOf(hours, function (x) { return x.cost === 1; });
    var hard = runsOf(hours, function (x) { return x.cost === 2; });

    // A single clear hour in the middle of a bad day is noise, not a plan.
    var realOpen = open.filter(function (r) { return r.end > r.start; });
    if (realOpen.length) open = realOpen;

    var usable = hours.filter(function (x) { return x.cost === 0; }).length;
    var hardHours = hours.filter(function (x) { return x.cost === 2; }).length;

    // The shape the verdict reads. 'open' is a day you can spend outside,
    // 'split' has a usable stretch and a write-off, 'shut' means the outdoor
    // half of the day is gone. 'grim' is uniformly mediocre with nothing to
    // schedule around, and gets no special sentence.
    var shape = usable === hours.length ? 'open'
              : usable > 0 ? 'split'
              : hardHours * 2 >= hours.length ? 'shut'
              : 'grim';

    return {
      from: from,
      to: to,
      open: open,
      soft: soft,
      hard: longestRun(hard),
      worstSoft: longestRun(soft),
      shape: shape,
      usableHours: usable,
      clear: hours.every(function (x) { return x.cost === 0; }),
      shut: hardHours > 0,
      sealed: hours.every(function (x) { return x.cost === 2; })
    };
  }

  function runLabel(run, w) {
    var a = run.start, b = run.end + 1;
    if (a <= w.from && b >= w.to) return 'all day';
    if (a <= w.from) return 'until ' + formatHour(b);
    if (b >= w.to) return 'after ' + formatHour(a);
    return span(a, b);
  }

  // Parallel adjectives, so the bad stretch reads the same way whatever closed it.
  var BAD_WORD = { rain: 'Wet', heat: 'Too hot', cold: 'Too cold' };

  // A rain day whose shut hours were also cold should still read as a rain day.
  function reasonOf(run, lead) {
    return (lead && run.tally && run.tally[lead]) ? lead : run.reason;
  }

  function badClause(run, w, pivot, lead) {
    var word = BAD_WORD[reasonOf(run, lead)];
    if (!word) return '';
    var a = run.start, b = run.end + 1;
    // When the bad stretch starts exactly where the good one ended, naming the
    // hour twice in one breath reads like a machine wrote it.
    if (pivot !== null && a === pivot && b >= w.to) return word + ' after that.';
    if (a <= w.from) return word + ' until ' + formatHour(b) + '.';
    if (b >= w.to) return word + ' from ' + formatHour(a) + ' on.';
    return word + ' ' + span(a, b) + '.';
  }

  function windowPhrase(w, lead) {
    if (!w || w.clear) return null;

    if (w.sealed) {
      return 'Nothing opens up between ' + formatHour(w.from) + ' and ' + formatHour(w.to) + '.';
    }

    // Prefer genuinely clear stretches. Where a day has none, the least bad
    // hours are still worth naming, but they do not get called clear.
    var best = w.open.length ? w.open : w.soft;
    var bestIsClear = w.open.length > 0;
    var bad = w.hard || (w.open.length ? w.worstSoft : null);

    // One flat level from end to end has no shape to describe, and the verdict
    // has already said what kind of day it is.
    if (!best.length || !bad) return null;

    var labels = best.map(function (r) { return runLabel(r, w); });
    var joined = labels.length === 1
      ? labels[0]
      : labels.slice(0, -1).join(', ') + ' and ' + labels[labels.length - 1];

    var last = best[best.length - 1];
    var pivot = bad.start > last.end ? last.end + 1 : null;
    var good = (bestIsClear ? 'Clear ' : 'Easiest ') + joined + '.';

    // Chronological order, always. "Easiest after 11am. Too cold until 11am."
    // is accurate and still reads backwards.
    if (bad.start < best[0].start) {
      var handover = bad.end + 1 === best[0].start && last.end + 1 >= w.to;
      return badClause(bad, w, null, lead) + ' ' +
             (bestIsClear ? 'Clear ' : 'Easiest ') +
             (handover ? 'after that' : joined) + '.';
    }
    var tail = badClause(bad, w, pivot, lead);
    return good + (tail ? ' ' + tail : '');
  }

  /* ---------------------------------------------------------------------
   * 6. Scoring. 0 fine, 1 caution, 2 severe.
   * ------------------------------------------------------------------ */

  function scoreRain(day, timing) {
    var p = day.rainProb, s = day.rainSum;
    var raw = 0;
    if ((p !== null && p > 70) || (s !== null && s > 10)) raw = 2;
    else if ((p !== null && p >= 40) || (s !== null && s >= 2)) raw = 1;

    // Deliberate demotion: rain that lands outside the walking window is not a
    // problem for this user, even though every other weather app flags it.
    if (raw > 0 && timing && timing.kind === 'offhours') raw -= 1;
    return raw;
  }

  function scoreHeat(day) {
    var t = day.feelsMax !== null ? day.feelsMax : day.tMax;
    if (t === null) return 0;
    if (t > HEAT_SEVERE) return 2;
    if (t >= HEAT_CAUTION) return 1;
    return 0;
  }

  function scoreCold(day) {
    var t = day.feelsMin !== null ? day.feelsMin : day.tMin;
    if (t === null) return 0;
    if (t < COLD_SEVERE) return 2;
    if (t <= COLD_CAUTION) return 1;
    return 0;
  }

  function scoreWind(day) {
    var w = day.wind;
    if (w === null) return 0;
    if (w > WIND_SEVERE) return 2;
    if (w >= WIND_CAUTION) return 1;
    return 0;
  }

  function scoreUv(day) {
    var u = day.uv;
    if (u === null) return 0;
    if (u > UV_SEVERE) return 2;
    if (u >= UV_CAUTION) return 1;
    return 0;
  }

  /* ---------------------------------------------------------------------
   * 7. Verdict sentences.
   *
   * One sentence of judgement per day. The hours live in the plan line below
   * it, so nothing here repeats a time range the window already gave.
   *
   * Where a day is the trip's own extreme, or where its shape differs (a hot
   * afternoon that cools off is a different day from one that does not), the
   * sentence says so. Only when two days really are alike does `repeat` pick a
   * different piece of advice rather than a reworded version of the same one.
   *
   * Two rules the sightseer persona imposes on every sentence below.
   *
   * Transport is free. This user gets between sights however they like, so bad
   * weather costs them the sights themselves, never the journey. Advice of the
   * form "keep the walking short" or "pick things you can reach without getting
   * soaked" charges them for a journey they were never going to walk, and
   * "pick the indoor things and walk between them" sends them out into the rain
   * it just warned about. What a wet day actually costs is the outdoor half of
   * the itinerary, and the useful reply is which half survives.
   *
   * The window has the last word. A verdict built from the daily score can
   * contradict the plan line built from the hourly one: "do the outdoor half
   * early" printed directly above "nothing opens up between 9am and 7pm". The
   * severe branches read `ctx.shape` first for exactly this reason.
   * ------------------------------------------------------------------ */

  // Cycles rather than clamping, so consecutive lookalike days never draw the
  // same line. `used` carries the sentences this trip has already printed, so a
  // long run of similar days skips past a variant it has spent rather than
  // repeating it verbatim on card five.
  function pick(list, repeat, used) {
    var start = repeat % list.length;
    for (var i = 0; i < list.length; i++) {
      var candidate = list[(start + i) % list.length];
      if (!used || !used[candidate]) return candidate;
    }
    return list[start];
  }

  function headlineFor(signal, level, day, ctx) {
    var feelsMax = round(day.feelsMax !== null ? day.feelsMax : day.tMax);
    var feelsMin = round(day.feelsMin !== null ? day.feelsMin : day.tMin);
    var swing = (feelsMax !== null && feelsMin !== null) ? feelsMax - feelsMin : null;
    var timing = ctx.timing;
    var hasPlan = !!ctx.plan;
    var repeat = ctx.repeat || 0;
    var mm = day.rainSum === null ? null : Math.round(day.rainSum * 10) / 10;

    if (signal === 'rain' && level === 2) {
      if (ctx.isWettest && ctx.tripDays > 1) {
        return 'The wettest day of the trip, ' + (mm ? mm + 'mm of it' : 'and it does not let up') +
               (ctx.shape === 'split'
                 ? '. Put the outdoor sights in the dry stretch and keep the rest under a roof.'
                 : '. Treat it as an indoor day and get between sights by taxi or metro.');
      }
      if (ctx.shape === 'split') {
        return pick([
          'Heavy rain, though not for the whole day. Put the outdoor sights in the clear stretch and the indoor ones either side.',
          'Heavy rain again, with a gap in it. Spend the gap outside and the rest under a roof.',
          'More heavy rain around one dry window. Anything outdoors goes in the window.'
        ], repeat, ctx.used);
      }
      if (ctx.shape === 'shut' || (timing && timing.kind === 'allday')) {
        // "Shut" means no clean hour, not no hour. The plan line underneath is
        // still naming the least-bad stretch, so these lean the day indoors
        // without forbidding the outdoors outright.
        return pick([
          'Heavy rain with no clean gap in it. Lean the day indoors, and get between sights by taxi or metro rather than on foot.',
          'Heavy rain again, and no dry stretch in it. Galleries and long lunches, with a taxi in between.',
          'A third wet one. Keep to indoor sights where you can, and skip anything that means standing around outside.'
        ], repeat, ctx.used);
      }
      if (!hasPlan && timing) {
        return 'Heavy rain, ' + timing.phrase + '. Line up an indoor stop for the worst of it.';
      }
      return pick([
        'Heavy rain today. Do the outdoor half early and keep something indoors in reserve.',
        'Heavy rain again. This is the day to spend on museums and long lunches.',
        'More heavy rain. Keep the outdoor list short; the journeys between are somebody else\'s problem.'
      ], repeat, ctx.used);
    }

    if (signal === 'rain' && level === 1) {
      // The rain is real, but it lands while you are not walking. Saying
      // "carry a raincoat" here would be technically true and useless.
      if (timing && timing.kind === 'offhours') {
        return 'Rain on the books, but almost all of it lands outside walking hours. ' +
               'Dry between 9am and 7pm, so you only need cover if you are out late.';
      }
      if (timing && timing.kind === 'scattered') {
        return 'Showers on and off, none of them settled. A shell you can stuff in a bag is enough.';
      }
      return pick([
        'Showers are a real chance at ' + (day.rainProb === null ? 'some point' : round(day.rainProb) + '%') +
          '. Take a shell you can pack away.',
        'More showers. Nothing that ruins a day, but keep the shell on you.',
        'Rain again, on and off. By now the shell lives in the bag.'
      ], repeat, ctx.used);
    }

    if (signal === 'heat' && level === 2) {
      if (ctx.isHottest && ctx.tripDays > 1) {
        return 'The hottest day of the trip at a feels-like ' + feelsMax +
               '°C. Treat the middle of it as indoor time.';
      }
      if (ctx.shape === 'shut') {
        return pick([
          'Nothing cool enough to be out in for long, peaking at a feels-like ' + feelsMax +
            '°C. Indoor sights today, and transport between them.',
          'Severe heat again, up to ' + feelsMax + '°C. The outdoor list waits for a cooler day.',
          'Another ' + feelsMax + '°C. Nothing outdoors repays the effort; spend it under a roof.'
        ], repeat, ctx.used);
      }
      return pick([
        'Too hot to walk far in the middle of the day. It peaks at a feels-like ' + feelsMax + '°C.',
        'Severe heat again, up to ' + feelsMax + '°C. Front-load the outdoor sights and take the afternoon indoors.',
        'Another ' + feelsMax + '°C peak. Move at dawn and dusk, and treat the rest as indoor time.'
      ], repeat, ctx.used);
    }

    if (signal === 'heat' && level === 1) {
      if (ctx.isHottest && ctx.tripDays > 1) {
        return 'Your warmest day at a feels-like ' + feelsMax +
               '°C. Get the long walk done before the afternoon.';
      }
      if (swing !== null && swing >= 12) {
        return feelsMax + '°C in the afternoon, down to ' + feelsMin +
               '°C once the sun goes. The evening is the good part.';
      }
      return pick([
        'Hot by mid-afternoon, feeling like ' + feelsMax + '°C. Start early and keep water on you.',
        'Another warm one at ' + feelsMax + '°C. Refill the bottle before you set off.',
        'Warm again, ' + feelsMax + '°C. Shade and a slower pace will cover it.'
      ], repeat, ctx.used);
    }

    if (signal === 'cold' && level === 2) {
      if (ctx.isColdest && ctx.tripDays > 1) {
        return 'The coldest of your days, down to a feels-like ' + feelsMin +
               '°C. Short stretches, and layer properly before you step out.';
      }
      if (ctx.shape === 'shut') {
        return pick([
          'No stretch of it warms up enough to linger outside, down to a feels-like ' + feelsMin +
            '°C. Indoor sights, and short transfers between them.',
          'Sharp cold again at ' + feelsMin + '°C. Another one to spend mostly under a roof.',
          'Still bitter, ' + feelsMin + '°C at the low. Warm rooms, and let something else do the travelling.'
        ], repeat, ctx.used);
      }
      return pick([
        'Hard cold, down to a feels-like ' + feelsMin + '°C. Keep the outdoor stretches short.',
        'Sharp cold again at ' + feelsMin + '°C. Plan the route around places you can warm up in.',
        'Cold enough to cut the day short, ' + feelsMin + '°C at the low. Warm rooms beat distance.'
      ], repeat, ctx.used);
    }

    if (signal === 'cold' && level === 1) {
      if (feelsMax !== null && feelsMax >= 14) {
        return 'Cold first thing at ' + feelsMin + '°C, then it climbs to ' + feelsMax +
               '°C. Wear something you can take off.';
      }
      return pick([
        'Cold all day, ' + feelsMin + '°C at the low. Walkable with a proper mid-layer.',
        'Cold again, down to ' + feelsMin + '°C. Gloves make more difference than another jumper.',
        'Still cold, ' + feelsMin + '°C. Short hops between warm rooms rather than one long push.'
      ], repeat, ctx.used);
    }

    if (signal === 'wind' && level === 2) {
      return pick([
        'Wind up to ' + round(day.wind) + ' km/h. Bridges and open squares will be no fun, so keep to sheltered streets.',
        'Strong wind again at ' + round(day.wind) + ' km/h. Anything held loosely will not stay held.',
        'Another ' + round(day.wind) + ' km/h day. Route through narrow streets and skip the waterfront.'
      ], repeat, ctx.used);
    }

    if (signal === 'wind' && level === 1) {
      return pick([
        'Breezy at ' + round(day.wind) + ' km/h. No real obstacle, though anything loose will flap.',
        'Windy again, ' + round(day.wind) + ' km/h. Worth pinning down a hat.',
        'Still breezy at ' + round(day.wind) + ' km/h. Only matters if you were planning a picnic.'
      ], repeat, ctx.used);
    }

    if (signal === 'uv' && level === 2) {
      return pick([
        'UV hits ' + round(day.uv) + '. Cover up and take the shade either side of noon.',
        'UV ' + round(day.uv) + ' once more. Long sleeves beat more sunscreen at this level.',
        'UV ' + round(day.uv) + ' again. Plan the middle of the day around arcades and awnings.'
      ], repeat, ctx.used);
    }

    if (signal === 'uv' && level === 1) {
      return pick([
        'Strong sun at UV ' + round(day.uv) + '. Sunscreen and a cap before you head out.',
        'UV ' + round(day.uv) + ' again. Top the sunscreen up at lunchtime.',
        'UV ' + round(day.uv) + ' once more. Sunglasses matter as much as the sunscreen by now.'
      ], repeat, ctx.used);
    }

    return null;
  }

  /*
   * The unremarkable day. Most days are unremarkable, and "partly cloudy, 26C"
   * is a non-answer, so a clear day still has to hand over one useful fact.
   */
  // Carrying the day's own high is what keeps thirteen clear days in a row from
  // reading as four sentences on a loop. The numbers differ even when nothing
  // else does.
  var CALM_VARIANTS = [
    function (t) { return t === null ? 'Nothing to plan around. The whole day is walkable.'
                                     : 'Nothing to plan around, and a steady ' + t + '\u00B0C.'; },
    function (t) { return t === null ? 'A clean day. Walk as far as you like.'
                                     : 'A clean day, topping out at ' + t + '\u00B0C.'; },
    function (t) { return t === null ? 'No weather to think about here.'
                                     : 'No weather to think about, just ' + t + '\u00B0C.'; },
    function (t) { return t === null ? 'Another easy one. Nothing needs working around.'
                                     : 'Another easy one, ' + t + '\u00B0C at its warmest.'; }
  ];

  // Calm on the daily numbers, but the hourly pass found a patch worth stepping
  // around. Saying "nothing to plan around" here would contradict the plan line.
  var CALM_WITH_PATCH = [
    function (t) { return t === null ? 'An easy day with one patch to step around.'
                                     : 'An easy ' + t + '\u00B0C, with one patch to step around.'; },
    function (t) { return t === null ? 'Good walking, apart from a short spell in the middle.'
                                     : 'Good walking at ' + t + '\u00B0C, apart from a short spell in the middle.'; },
    function (t) { return t === null ? 'Nearly clean. One stretch is worth sitting out.'
                                     : 'Nearly clean at ' + t + '\u00B0C. One stretch is worth sitting out.'; }
  ];

  function calmHeadline(day, flags, index, used) {
    if (!flags.hasData) {
      return 'No forecast published for this day yet. Check again closer to the date.';
    }

    var warm = round(day.feelsMax !== null ? day.feelsMax : day.tMax);
    var render = function (fns) {
      return pick(fns.map(function (f) { return f(warm); }), index, used);
    };

    if (flags.hasPatch) {
      return render(CALM_WITH_PATCH);
    }

    var lead;
    if (flags.isBest) lead = 'Your best walking day of the trip. Nothing to plan around.';
    else if (flags.isWarmest) lead = 'Comfortably the warmest day, and nothing working against you.';
    else if (flags.isCoolest) lead = 'The coolest day you get, and nothing else working against you.';
    else if (flags.isLongest) lead = 'Nothing to plan around, and the longest daylight of the trip.';
    else lead = render(CALM_VARIANTS);

    // Sunrise and sunset are the same numbers every day of a short trip, so
    // printing them on every card is four cards ending in one sentence. It goes
    // on the day it actually means something and nowhere else.
    var rise = clockFromIso(day.sunrise);
    var set = clockFromIso(day.sunset);
    var light = (flags.showLight && rise && set) ? ' Daylight ' + rise + ' to ' + set + '.' : '';

    return (lead + light).trim();
  }

  /* ---------------------------------------------------------------------
   * 8. Per-day analysis
   * ------------------------------------------------------------------ */

  function analyseDay(day, hourly) {
    var timing = rainTiming(hourly, day.date);
    var window = walkingWindow(hourly, day);
    var scores = {
      rain: scoreRain(day, timing),
      heat: scoreHeat(day),
      cold: scoreCold(day),
      wind: scoreWind(day),
      uv: scoreUv(day)
    };

    var severity = 0;
    PRIORITY.forEach(function (k) { severity = Math.max(severity, scores[k]); });

    // Headline signal: highest score, ties broken by PRIORITY order.
    var lead = null;
    if (severity > 0) {
      for (var i = 0; i < PRIORITY.length; i++) {
        if (scores[PRIORITY[i]] === severity) { lead = PRIORITY[i]; break; }
      }
    }

    // Everything else that fired becomes a secondary chip.
    var chips = PRIORITY.filter(function (k) {
      return k !== lead && scores[k] > 0;
    }).map(function (k) {
      return { signal: k, level: scores[k], label: THRESHOLDS[k].label };
    });

    // A day with no usable numbers must not masquerade as a perfect day.
    var hasData = [day.tMax, day.tMin, day.feelsMax, day.feelsMin,
                   day.rainProb, day.uv, day.wind]
      .some(function (v) { return v !== null; });

    return {
      date: day.date,
      label: prettyDate(day.date),
      raw: day,
      hasData: hasData,
      scores: scores,
      severity: severity,
      lead: lead,
      chips: chips,
      timing: timing,
      window: window,
      // headline and plan are filled in by analyse, which knows the whole trip
      headline: null,
      plan: null,
      stats: {
        high: round(day.tMax),
        low: round(day.tMin),
        feelsHigh: round(day.feelsMax),
        feelsLow: round(day.feelsMin),
        rainProb: round(day.rainProb),
        rainSum: day.rainSum === null ? null : Math.round(day.rainSum * 10) / 10,
        uv: round(day.uv),
        wind: round(day.wind),
        sunrise: clockFromIso(day.sunrise),
        sunset: clockFromIso(day.sunset)
      }
    };
  }

  /* ---------------------------------------------------------------------
   * 9. Packing list. One list for the trip, deduplicated.
   *
   * Only conditional items. A packing list that tells you to bring a phone
   * charger has told you nothing; every line here exists because a signal
   * fired on at least one day of THIS trip.
   * ------------------------------------------------------------------ */

  var PACKING_RULES = [
    { item: 'Packable rain shell or compact umbrella',
      when: function (t) { return t.rain >= 1; },
      why: function (t) { return 'rain on ' + t.rainDays + (t.rainDays === 1 ? ' day' : ' days'); } },

    { item: 'Quick-dry top and a dry bag for your phone',
      when: function (t) { return t.rain >= 2; },
      why: function () { return 'at least one day of heavy rain'; } },

    { item: 'Windbreaker',
      // Skipped when a rain shell is already on the list. It does the same job.
      when: function (t) { return t.wind >= 1 && t.rain === 0; },
      why: function (t) { return 'gusts up to ' + t.maxWind + ' km/h'; } },

    { item: 'SPF 50 sunscreen',
      when: function (t) { return t.uv >= 1; },
      why: function (t) { return 'UV peaks at ' + t.maxUv; } },

    { item: 'Cap and sunglasses',
      when: function (t) { return t.uv >= 1; },
      why: function () { return 'no shade on a walking route'; } },

    { item: 'Refillable 1L bottle',
      when: function (t) { return t.heat >= 1; },
      why: function (t) { return 'feels-like highs of ' + t.maxFeels + '°C'; } },

    { item: 'Electrolyte sachets',
      when: function (t) { return t.heat >= 2; },
      why: function () { return 'sustained heat, and you will be sweating it out'; } },

    { item: 'Insulating mid-layer',
      when: function (t) { return t.cold >= 1; },
      why: function (t) { return 'feels-like lows of ' + t.minFeels + '°C'; } },

    { item: 'Gloves and a beanie',
      when: function (t) { return t.cold >= 2; },
      why: function () { return 'sub-zero mornings'; } },

    { item: 'One packable layer you can add and shed',
      when: function (t) { return t.maxSwing > 12; },
      why: function (t) { return t.maxSwing + '°C swing between day and night'; } },

    { item: 'Something to fill an afternoon indoors',
      // Earned only when the hourly pass shows hours that are genuinely shut,
      // which is a different claim from "it might rain at some point".
      when: function (t) { return t.shutDays >= 2; },
      why: function (t) { return t.shutDays + ' days have hours not worth being outside'; } }
  ];

  var BASE_ITEMS = [
    { item: 'Broken-in walking shoes', why: 'the sightseeing is on foot every day' },
    { item: 'Blister plasters', why: '5-8 km a day adds up' }
  ];

  function tripSignals(days) {
    var t = {
      rain: 0, heat: 0, cold: 0, wind: 0, uv: 0,
      rainDays: 0, maxWind: 0, maxUv: 0, shutDays: 0,
      maxFeels: -99, minFeels: 99, maxSwing: 0
    };
    days.forEach(function (d) {
      ['rain', 'heat', 'cold', 'wind', 'uv'].forEach(function (k) {
        t[k] = Math.max(t[k], d.scores[k]);
      });
      if (d.scores.rain > 0) t.rainDays += 1;
      if (d.window && d.window.shut) t.shutDays += 1;
      if (d.stats.wind !== null) t.maxWind = Math.max(t.maxWind, d.stats.wind);
      if (d.stats.uv !== null) t.maxUv = Math.max(t.maxUv, d.stats.uv);

      var hi = d.stats.feelsHigh !== null ? d.stats.feelsHigh : d.stats.high;
      var lo = d.stats.feelsLow !== null ? d.stats.feelsLow : d.stats.low;
      if (hi !== null) t.maxFeels = Math.max(t.maxFeels, hi);
      if (lo !== null) t.minFeels = Math.min(t.minFeels, lo);
      if (hi !== null && lo !== null) t.maxSwing = Math.max(t.maxSwing, hi - lo);
    });
    return t;
  }

  function packingList(days) {
    var t = tripSignals(days);
    var conditional = PACKING_RULES
      .filter(function (r) { return r.when(t); })
      .map(function (r) { return { item: r.item, why: r.why(t) }; });
    return { conditional: conditional, base: BASE_ITEMS, signals: t };
  }

  /* ---------------------------------------------------------------------
   * 10. Trip summary. One line answering "how is this trip looking".
   * ------------------------------------------------------------------ */

  function tripSummary(days) {
    var n = days.length;
    var good = days.filter(function (d) { return d.severity === 0; }).length;
    var caution = days.filter(function (d) { return d.severity === 1; }).length;
    var severe = days.filter(function (d) { return d.severity === 2; }).length;

    // Which signal causes the most trouble across the trip?
    var tally = {};
    days.forEach(function (d) { if (d.lead) tally[d.lead] = (tally[d.lead] || 0) + d.severity; });
    var dominant = Object.keys(tally).sort(function (a, b) { return tally[b] - tally[a]; })[0];
    var theme = dominant
      ? ' ' + THRESHOLDS[dominant].label + ' is the recurring theme.'
      : '';

    var best = days.filter(function (d) { return d.severity === 0; })[0] || null;
    if (!best) {
      best = days.slice().sort(function (a, b) {
        if (a.severity !== b.severity) return a.severity - b.severity;
        return (a.stats.rainProb || 0) - (b.stats.rainProb || 0);
      })[0];
    }

    function dayWord(k) { return k === 1 ? 'day' : 'days'; }

    var line;
    if (n === 1) {
      // A one-day trip has no window to describe, so talk about the day itself.
      // No recurring theme either; the verdict below already says it.
      var only = days[0];
      if (only.severity === 0) line = only.label + ' looks like a good day to be out.';
      else if (only.severity === 1) line = only.label + ' is workable with a bit of planning.';
      else line = only.label + ' is going to fight you. Plan for indoors.';
    } else if (severe === 0 && caution === 0) {
      line = 'Strong window. All ' + n + ' days are good for walking.';
    } else if (severe === 0 && good === 0) {
      line = 'No washouts, but every day needs a little planning.' + theme;
    } else if (severe === 0) {
      line = 'Mostly good: ' + good + ' clear ' + dayWord(good) + ', and ' + caution +
             ' that ' + (caution === 1 ? 'needs' : 'need') + ' a little planning.';
    } else if (good + caution === 0) {
      line = 'Rough window. Every day has something working against it.' + theme;
    } else if (severe >= Math.ceil(n / 2)) {
      line = 'Tough window. Only ' + (good + caution) + ' of ' + n +
             ' days are comfortable outdoors.' + theme;
    } else {
      line = 'Workable, but ' + severe + ' of ' + n + ' ' + dayWord(n) +
             ' will get in your way.' + theme;
    }

    return {
      line: line,
      best: best,
      counts: { good: good, caution: caution, severe: severe, total: n }
    };
  }

  /* ---------------------------------------------------------------------
   * 11. Entry point
   * ------------------------------------------------------------------ */

  // A superlative is only worth claiming when it is clearly the extreme. On a
  // tie, or a margin the reader would not feel, no day gets to be "the hottest".
  function extremeDate(days, valueOf, better, margin) {
    var ranked = days
      .map(function (d) { return { date: d.date, v: valueOf(d) }; })
      .filter(function (x) { return x.v !== null; })
      .sort(function (a, b) { return better(a.v, b.v) ? -1 : 1; });
    if (ranked.length < 2) return null;
    return better(ranked[0].v, ranked[1].v) &&
           Math.abs(ranked[0].v - ranked[1].v) >= margin ? ranked[0].date : null;
  }

  function analyse(payload) {
    var rows = normalise(payload);
    if (!rows.length) return null;

    var hourly = payload.hourly || null;
    var days = rows.map(function (r) { return analyseDay(r, hourly); });

    var feelsHigh = function (d) {
      return d.stats.feelsHigh !== null ? d.stats.feelsHigh : d.stats.high;
    };
    var feelsLow = function (d) {
      return d.stats.feelsLow !== null ? d.stats.feelsLow : d.stats.low;
    };
    var gt = function (a, b) { return a > b; };
    var lt = function (a, b) { return a < b; };

    var hottest = extremeDate(days, feelsHigh, gt, 1);
    var coldest = extremeDate(days, feelsLow, lt, 1);
    var coolest = extremeDate(days, feelsHigh, lt, 2);
    var wettest = extremeDate(days, function (d) { return d.stats.rainSum; }, gt, 2);

    // Warmest is a softer claim than hottest and is only used on calm days,
    // so it does not need the same margin.
    var warmest = null, longest = null, longestSpan = -1;
    days.forEach(function (d) {
      var hi = feelsHigh(d);
      if (hi !== null && (warmest === null || hi > warmest.hi)) warmest = { hi: hi, date: d.date };
      if (d.raw.sunrise && d.raw.sunset) {
        var s = Date.parse(d.raw.sunset + 'Z') - Date.parse(d.raw.sunrise + 'Z');
        if (s > longestSpan) { longestSpan = s; longest = d.date; }
      }
    });

    var summary = tripSummary(days);
    var bestDate = summary.best ? summary.best.date : null;

    var seen = {};
    var used = {};
    var lightShown = false;
    days.forEach(function (d, i) {
      d.plan = windowPhrase(d.window, d.lead);

      if (d.severity === 0) {
        var isBest = d.hasData && d.date === bestDate && days.length > 1;
        var isWarmest = d.hasData && warmest && d.date === warmest.date && days.length > 1;
        var isCoolest = d.hasData && d.date === coolest && !isWarmest && !isBest;
        var isLongest = d.hasData && d.date === longest && days.length > 2;
        var plain = !isBest && !isWarmest && !isCoolest && !isLongest;

        // Daylight is stated once per trip: on the longest day, or failing that
        // on the first calm day that has no superlative of its own to offer.
        var showLight = !lightShown && (isLongest || plain);
        if (showLight) lightShown = true;

        d.headline = calmHeadline(d.raw, {
          hasData: d.hasData,
          hasPatch: d.hasData && !!d.plan,
          isBest: isBest,
          isWarmest: isWarmest,
          isCoolest: isCoolest,
          isLongest: isLongest,
          showLight: showLight
        }, i, used);
        if (d.headline) used[d.headline] = true;
        return;
      }

      var key = d.lead + ':' + d.severity;
      var repeat = seen[key] || 0;
      seen[key] = repeat + 1;

      d.headline = headlineFor(d.lead, d.severity, d.raw, {
        timing: d.timing,
        plan: d.plan,
        shape: d.window ? d.window.shape : null,
        repeat: repeat,
        used: used,
        tripDays: days.length,
        isHottest: d.date === hottest,
        isColdest: d.date === coldest,
        isWettest: d.date === wettest
      });
      if (d.headline) used[d.headline] = true;
    });

    return {
      audience: AUDIENCE,
      days: days,
      summary: summary,
      packing: packingList(days),
      thresholds: THRESHOLDS,
      priority: PRIORITY
    };
  }

  return {
    analyse: analyse,
    normalise: normalise,
    rainTiming: rainTiming,
    walkingWindow: walkingWindow,
    windowPhrase: windowPhrase,
    prettyDate: prettyDate,
    AUDIENCE: AUDIENCE,
    THRESHOLDS: THRESHOLDS,
    PRIORITY: PRIORITY,
    ACTIVE_START: ACTIVE_START,
    ACTIVE_END: ACTIVE_END
  };
});
