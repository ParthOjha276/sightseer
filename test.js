/*
 * test.js — runs the engine against LIVE Open-Meteo data for a spread of
 * climates, so we can see whether the verdicts read like advice or like noise.
 *
 *   node test.js
 */
const Engine = require('./engine.js');

const DAILY = [
  'temperature_2m_max', 'temperature_2m_min',
  'apparent_temperature_max', 'apparent_temperature_min',
  'precipitation_probability_max', 'precipitation_sum',
  'uv_index_max', 'wind_speed_10m_max',
  'sunrise', 'sunset'
].join(',');

const CASES = [
  { city: 'New Delhi' },      // two-word name — the stated rejection trap
  { city: 'Springfield' },    // the ambiguity trap
  { city: 'Reykjavik' },      // cold
  { city: 'Dubai' },          // heat + UV
  { city: 'Bergen' },         // rain
  { city: 'asdfghjkl' }       // no match
];

function isoDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function geocode(city) {
  const url = 'https://geocoding-api.open-meteo.com/v1/search?name=' +
    encodeURIComponent(city) + '&count=5&language=en&format=json';
  const r = await fetch(url);
  if (!r.ok) throw new Error('geocode HTTP ' + r.status);
  const j = await r.json();
  return j.results || [];
}

async function forecast(lat, lon, start, end) {
  const url = 'https://api.open-meteo.com/v1/forecast' +
    '?latitude=' + lat + '&longitude=' + lon +
    '&daily=' + DAILY +
    '&hourly=precipitation_probability,apparent_temperature' +
    '&timezone=auto&start_date=' + start + '&end_date=' + end;
  const r = await fetch(url);
  if (!r.ok) throw new Error('forecast HTTP ' + r.status);
  return r.json();
}

(async () => {
  const start = isoDate(0);
  const end = isoDate(5);
  console.log('Range:', start, '->', end, '\n');

  for (const c of CASES) {
    console.log('='.repeat(72));
    console.log('CITY:', c.city);
    let matches;
    try {
      matches = await geocode(c.city);
    } catch (e) {
      console.log('  geocode failed:', e.message);
      continue;
    }
    if (!matches.length) {
      console.log('  -> no matches (app shows the not-found error state) OK');
      continue;
    }
    console.log('  matches:', matches.length,
      matches.map(m => `${m.name}/${m.admin1 || '-'}/${m.country_code}`).join('  |  '));
    if (matches.length > 1) {
      console.log('  -> app shows the disambiguation state; using top match for this test');
    }

    const m = matches[0];
    const payload = await forecast(m.latitude, m.longitude, start, end);
    const result = Engine.analyse(payload);
    if (!result) { console.log('  !! analyse returned null'); continue; }

    console.log('\n  SUMMARY: ' + result.summary.line);
    result.days.forEach(d => {
      const badge = ['ok  ', 'WARN', 'BAD '][d.severity];
      console.log(`  [${badge}] ${d.label.padEnd(11)} ${d.headline}`);
      if (d.chips.length) {
        console.log(' '.repeat(20) + 'also: ' +
          d.chips.map(x => x.label + (x.level === 2 ? '!!' : '')).join(', '));
      }
    });
    console.log('\n  PACKING:');
    result.packing.conditional.forEach(p => console.log(`    - ${p.item}  (${p.why})`));
    result.packing.base.forEach(p => console.log(`    - ${p.item}  (${p.why})`));
    console.log('');
  }

  console.log('='.repeat(72));
  console.log('Edge checks');
  const empty = Engine.analyse({ daily: { time: [] } });
  console.log('  empty daily ->', empty === null ? 'null, handled OK' : 'UNEXPECTED');
  const missing = Engine.analyse({});
  console.log('  no daily key ->', missing === null ? 'null, handled OK' : 'UNEXPECTED');
  const nulls = Engine.analyse({
    daily: {
      time: ['2026-09-10'],
      temperature_2m_max: [null], temperature_2m_min: [null],
      apparent_temperature_max: [null], apparent_temperature_min: [null],
      precipitation_probability_max: [null], precipitation_sum: [null],
      uv_index_max: [null], wind_speed_10m_max: [null],
      sunrise: [null], sunset: [null]
    }
  });
  console.log('  all-null day ->', nulls ? 'survived: "' + nulls.days[0].headline + '"' : 'CRASHED');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
