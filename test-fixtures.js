/*
 * test-fixtures.js: exercises the engine offline against payloads shaped
 * exactly like Open-Meteo's, covering each climate the verdict logic has to
 * handle plus the degenerate cases.
 *
 *   node test-fixtures.js
 */
const Engine = require('./engine.js');

function day(date, o) {
  return Object.assign({
    date,
    tMax: 24, tMin: 16, feelsMax: 24, feelsMin: 16,
    rainProb: 5, rainSum: 0, uv: 4, wind: 10,
    sunrise: date + 'T06:12', sunset: date + 'T18:42'
  }, o);
}

// Build an Open-Meteo shaped payload from simple day specs.
// Hourly apparent temperature follows a plain diurnal curve peaking at 3pm, so
// the walking-window logic gets something shaped like a real day to read.
function feelsAt(s, h) {
  if (s.feelsMax === null || s.feelsMin === null) return null;
  const mid = (s.feelsMax + s.feelsMin) / 2;
  const amp = (s.feelsMax - s.feelsMin) / 2;
  return Math.round((mid + amp * Math.cos(((h - 15) / 24) * 2 * Math.PI)) * 10) / 10;
}

function payload(specs, hourlyRainByDate) {
  const daily = {
    time: [], temperature_2m_max: [], temperature_2m_min: [],
    apparent_temperature_max: [], apparent_temperature_min: [],
    precipitation_probability_max: [], precipitation_sum: [],
    uv_index_max: [], wind_speed_10m_max: [], sunrise: [], sunset: []
  };
  specs.forEach(s => {
    daily.time.push(s.date);
    daily.temperature_2m_max.push(s.tMax);
    daily.temperature_2m_min.push(s.tMin);
    daily.apparent_temperature_max.push(s.feelsMax);
    daily.apparent_temperature_min.push(s.feelsMin);
    daily.precipitation_probability_max.push(s.rainProb);
    daily.precipitation_sum.push(s.rainSum);
    daily.uv_index_max.push(s.uv);
    daily.wind_speed_10m_max.push(s.wind);
    daily.sunrise.push(s.sunrise);
    daily.sunset.push(s.sunset);
  });

  const hourly = { time: [], precipitation_probability: [], apparent_temperature: [] };
  specs.forEach(s => {
    for (let h = 0; h < 24; h++) {
      hourly.time.push(s.date + 'T' + String(h).padStart(2, '0') + ':00');
      const fn = hourlyRainByDate && hourlyRainByDate[s.date];
      hourly.precipitation_probability.push(fn ? fn(h) : Math.min(s.rainProb, 20));
      hourly.apparent_temperature.push(feelsAt(s, h));
    }
  });

  return { daily, hourly, timezone: 'Asia/Kolkata' };
}

function show(title, p) {
  const r = Engine.analyse(p);
  console.log('\n' + '='.repeat(74));
  console.log(title);
  console.log('='.repeat(74));
  if (!r) { console.log('  analyse -> null'); return; }
  console.log('SUMMARY: ' + r.summary.line + '\n');
  r.days.forEach(d => {
    const badge = ['  ok', 'WARN', ' BAD'][d.severity];
    console.log(`[${badge}] ${d.label.padEnd(11)} ${d.headline}`);
    if (d.plan) console.log('        plan: ' + d.plan);
    if (d.chips.length) {
      console.log('        also: ' + d.chips.map(x => x.label + (x.level === 2 ? ' (severe)' : '')).join(', '));
    }
  });
  console.log('\nPACKING');
  r.packing.conditional.forEach(x => console.log(`  • ${x.item}  (${x.why})`));
  r.packing.base.forEach(x => console.log(`  · ${x.item}  (${x.why})`));
}

/* 1. A calm trip, every day unremarkable. The hardest case to write well. */
show('CALM: mild European autumn, nothing wrong', payload([
  day('2026-09-06'), day('2026-09-07', { tMax: 26, feelsMax: 26 }),
  day('2026-09-08', { tMax: 22, feelsMax: 22 }), day('2026-09-09')
]));

/* 2. Afternoon rain block, should produce "mainly 2-6pm". */
show('RAIN BLOCK: showers confined to the afternoon', payload([
  day('2026-09-06', { rainProb: 65, rainSum: 6 })
], { '2026-09-06': h => (h >= 14 && h <= 17) ? 80 : 10 }));

/* 3. Rain overnight only, so the demotion rule should fire. */
show('OFF-HOURS RAIN: 80% chance, all of it at 3am', payload([
  day('2026-09-06', { rainProb: 80, rainSum: 9 })
], { '2026-09-06': h => (h >= 1 && h <= 5) ? 90 : 8 }));

/* 4. Several signals at once, and one clear sentence must still come out. */
show('CONFLICT: hot + wet + high UV + windy on the same day', payload([
  day('2026-09-06', { tMax: 39, feelsMax: 41, tMin: 29, feelsMin: 31,
                      rainProb: 75, rainSum: 12, uv: 10, wind: 45 })
], { '2026-09-06': h => (h >= 10 && h <= 18) ? 85 : 40 }));

/* 5. Cold. */
show('COLD: sub-zero mornings, big day/night swing', payload([
  day('2026-09-06', { tMax: 6, feelsMax: 3, tMin: -5, feelsMin: -9, uv: 2, wind: 28 }),
  day('2026-09-07', { tMax: 9, feelsMax: 7, tMin: 1, feelsMin: -2, uv: 2, wind: 12 })
]));

/* 6. Heat + UV, no rain, checking the windbreaker/rain-shell dedup does NOT fire. */
show('DESERT: heat and punishing sun, dry and windy', payload([
  day('2026-09-06', { tMax: 43, feelsMax: 47, tMin: 31, feelsMin: 33, uv: 11, wind: 30, rainProb: 0, rainSum: 0 }),
  day('2026-09-07', { tMax: 41, feelsMax: 44, tMin: 30, feelsMin: 32, uv: 10, wind: 12, rainProb: 0, rainSum: 0 })
]));

/* 7. Near-identical days. Before the rewrite these produced one sentence,
      copy-pasted three times. Each day must now say something of its own. */
show('REPEATS: three hot days that barely differ', payload([
  day('2026-09-06', { tMax: 35, feelsMax: 37, tMin: 26, feelsMin: 27, uv: 7, rainProb: 5, rainSum: 0 }),
  day('2026-09-07', { tMax: 35, feelsMax: 37, tMin: 26, feelsMin: 27, uv: 7, rainProb: 5, rainSum: 0 }),
  day('2026-09-08', { tMax: 35, feelsMax: 37, tMin: 26, feelsMin: 27, uv: 7, rainProb: 5, rainSum: 0 }),
  day('2026-09-09', { tMax: 36, feelsMax: 39, tMin: 26, feelsMin: 27, uv: 8, rainProb: 5, rainSum: 0 })
]));

/* 8. The window doing the work: a hot day whose morning is still fine. */
show('WINDOW: severe afternoon heat, walkable morning', payload([
  day('2026-09-06', { tMax: 40, feelsMax: 43, tMin: 24, feelsMin: 25, uv: 9, rainProb: 0, rainSum: 0 })
]));

/* 9. The verdict and the plan line are computed from different passes, the
      daily one and the hourly one, so they can disagree. Here heat seals the
      whole window while rain only falls in a block, which makes rain the
      headline signal. The verdict used to say "do the outdoor half early"
      directly above "nothing opens up between 9am and 7pm". */
show('COHERENCE: sealed by heat, led by rain', payload([
  day('2026-09-06', { tMax: 41, feelsMax: 44, tMin: 30, feelsMin: 32,
                      rainProb: 85, rainSum: 14, uv: 9, wind: 12 })
], { '2026-09-06': h => (h >= 14 && h <= 17) ? 90 : 20 }));

/* 10. Degenerate inputs. */
console.log('\n' + '='.repeat(74));
console.log('EDGE CASES');
console.log('='.repeat(74));
console.log('empty daily      ->', Engine.analyse({ daily: { time: [] } }) === null ? 'null (handled)' : 'UNEXPECTED');
console.log('no daily key     ->', Engine.analyse({}) === null ? 'null (handled)' : 'UNEXPECTED');
console.log('undefined        ->', Engine.analyse(undefined) === null ? 'null (handled)' : 'UNEXPECTED');
const nulls = Engine.analyse(payload([day('2026-09-10', {
  tMax: null, tMin: null, feelsMax: null, feelsMin: null,
  rainProb: null, rainSum: null, uv: null, wind: null, sunrise: null, sunset: null
})]));
console.log('all-null day     ->', nulls ? 'survived: "' + nulls.days[0].headline.trim() + '"' : 'CRASHED');
const single = Engine.analyse(payload([day('2026-09-10')]));
console.log('single-day trip  ->', single ? 'ok: "' + single.summary.line + '"' : 'CRASHED');
const noHourly = Engine.analyse({ daily: payload([day('2026-09-10', { rainProb: 60, rainSum: 5 })]).daily });
console.log('no hourly block  ->', noHourly ? 'ok: "' + noHourly.days[0].headline + '"' : 'CRASHED');

const repeats = Engine.analyse(payload([
  day('2026-09-06', { tMax: 35, feelsMax: 37, tMin: 26, feelsMin: 27, uv: 7, rainProb: 5, rainSum: 0 }),
  day('2026-09-07', { tMax: 35, feelsMax: 37, tMin: 26, feelsMin: 27, uv: 7, rainProb: 5, rainSum: 0 }),
  day('2026-09-08', { tMax: 35, feelsMax: 37, tMin: 26, feelsMin: 27, uv: 7, rainProb: 5, rainSum: 0 })
])).days.map(d => d.headline);
const unique = new Set(repeats).size;
console.log('identical days   ->', unique === repeats.length
  ? `ok: ${repeats.length} lookalike days, ${unique} distinct verdicts`
  : `FAIL: ${repeats.length} days but only ${unique} distinct verdicts`);

// The verdict must never promise outdoor time the plan line has ruled out.
const sealed = Engine.analyse(payload([
  day('2026-09-06', { tMax: 41, feelsMax: 44, tMin: 30, feelsMin: 32,
                      rainProb: 85, rainSum: 14, uv: 9, wind: 12 })
], { '2026-09-06': h => (h >= 14 && h <= 17) ? 90 : 20 })).days[0];
const promisesOutdoor = /outdoor half|do the outdoor|get out early|dry stretch|clear stretch/i.test(sealed.headline);
const planSaysShut = /Nothing opens up/i.test(sealed.plan || '');
console.log('verdict/plan     ->', (planSaysShut && promisesOutdoor)
  ? `FAIL: "${sealed.headline}" above "${sealed.plan}"`
  : 'ok: a shut day is never told to go outside');

// Nothing may tell this persona to walk between sights. Transport is free.
const walkerisms = [];
[['Jaipur', 41, 44, 85, 14], ['Oslo', 4, 1, 80, 12], ['Cairo', 43, 47, 0, 0]].forEach(([, tx, fx, rp, rs]) => {
  Engine.analyse(payload([
    day('2026-09-06', { tMax: tx, feelsMax: fx, tMin: tx - 10, feelsMin: fx - 12, rainProb: rp, rainSum: rs }),
    day('2026-09-07', { tMax: tx, feelsMax: fx, tMin: tx - 10, feelsMin: fx - 12, rainProb: rp, rainSum: rs }),
    day('2026-09-08', { tMax: tx, feelsMax: fx, tMin: tx - 10, feelsMin: fx - 12, rainProb: rp, rainSum: rs })
  ], { '2026-09-06': () => rp, '2026-09-07': () => rp, '2026-09-08': () => rp }))
    .days.forEach(d => {
      if (/walk between|walking short|without getting soaked|close to shelter/i.test(d.headline)) {
        walkerisms.push(d.headline);
      }
    });
});
console.log('persona fit      ->', walkerisms.length === 0
  ? 'ok: no verdict charges the sightseer for a journey they can take a taxi for'
  : `FAIL: ${walkerisms[0]}`);
