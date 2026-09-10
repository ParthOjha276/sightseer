/*
 * ui-test.js: loads index.html in headless Chromium with the Open-Meteo calls
 * intercepted, walks every state, and screenshots each one.
 *
 *   node ui-test.js
 */
const { chromium } = require('playwright');
const path = require('path');

const DAILY_KEYS = [
  'temperature_2m_max', 'temperature_2m_min',
  'apparent_temperature_max', 'apparent_temperature_min',
  'precipitation_probability_max', 'precipitation_sum',
  'uv_index_max', 'wind_speed_10m_max', 'sunrise', 'sunset'
];

function buildForecast(specs) {
  const daily = { time: [] };
  DAILY_KEYS.forEach(k => daily[k] = []);
  const hourly = { time: [], precipitation_probability: [] };
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
    daily.sunrise.push(s.date + 'T06:12');
    daily.sunset.push(s.date + 'T18:42');
    for (let h = 0; h < 24; h++) {
      hourly.time.push(s.date + 'T' + String(h).padStart(2, '0') + ':00');
      hourly.precipitation_probability.push(
        s.wetHours && s.wetHours.includes(h) ? 85 : Math.min(s.rainProb, 15));
    }
  });
  return { daily, hourly, timezone: 'Asia/Kolkata' };
}

function d(date, o = {}) {
  return Object.assign({
    date, tMax: 31, tMin: 24, feelsMax: 34, feelsMin: 25,
    rainProb: 20, rainSum: 0.4, uv: 7, wind: 14
  }, o);
}

const dates = (() => {
  const out = [];
  const base = new Date();
  for (let i = 0; i < 5; i++) {
    const x = new Date(base); x.setDate(x.getDate() + i);
    out.push(x.toISOString().slice(0, 10));
  }
  return out;
})();

const SCENARIOS = {
  jaipur: {
    geo: [{ name: 'Jaipur', latitude: 26.91, longitude: 75.79, country: 'India',
            admin1: 'Rajasthan', population: 2711758, country_code: 'IN' }],
    fc: buildForecast([
      d(dates[0], { rainProb: 65, rainSum: 7, wetHours: [14, 15, 16, 17] }),
      d(dates[1], { tMax: 39, feelsMax: 43, uv: 10, rainProb: 5, rainSum: 0 }),
      d(dates[2], { tMax: 27, feelsMax: 28, tMin: 20, feelsMin: 21, uv: 5, rainProb: 10, rainSum: 0 }),
      d(dates[3], { tMax: 26, feelsMax: 26, tMin: 19, feelsMin: 19, uv: 4, rainProb: 0, rainSum: 0, wind: 9 }),
      d(dates[4], { rainProb: 90, rainSum: 22, wind: 44, uv: 3, wetHours: [9,10,11,12,13,14,15,16,17,18] })
    ])
  },
  springfield: {
    geo: [
      { name: 'Springfield', latitude: 37.21, longitude: -93.29, country: 'United States', admin1: 'Missouri', population: 169176 },
      { name: 'Springfield', latitude: 42.10, longitude: -72.58, country: 'United States', admin1: 'Massachusetts', population: 155929 },
      { name: 'Springfield', latitude: 39.79, longitude: -89.64, country: 'United States', admin1: 'Illinois', population: 116250 },
      { name: 'Springfield', latitude: 39.92, longitude: -83.80, country: 'United States', admin1: 'Ohio', population: 58662 },
      { name: 'Springfield', latitude: -37.75, longitude: 145.20, country: 'Australia', admin1: 'Victoria', population: 1200 }
    ]
  },
  nowhere: { geo: [] },
  boom: { fail: true }
};

(async () => {
  const browser = await chromium.launch();
  const results = [];

  async function makePage(width = 1100, height = 900) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

    await page.route('**/geocoding-api.open-meteo.com/**', route => {
      const url = new URL(route.request().url());
      const name = (url.searchParams.get('name') || '').toLowerCase();
      const key = name.includes('spring') ? 'springfield'
                : name.includes('boom') ? 'boom'
                : name.includes('jaipur') || name.includes('delhi') ? 'jaipur'
                : 'nowhere';
      const s = SCENARIOS[key];
      if (s.fail) return route.fulfill({ status: 500, body: 'server error' });
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(s.geo.length ? { results: s.geo } : {}) });
    });
    await page.route('**/api.open-meteo.com/**', route => {
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(SCENARIOS.jaipur.fc) });
    });

    await page.goto('file://' + path.join(__dirname, 'index.html'));
    return { page, ctx, errors };
  }

  async function visible(page) {
    return page.evaluate(() => ['stateEmpty','stateLoading','stateChoose','stateError','stateResults']
      .filter(id => !document.getElementById(id).hidden));
  }

  // 1. EMPTY
  {
    const { page, ctx, errors } = await makePage();
    results.push(['empty state', (await visible(page)).join(',') === 'stateEmpty', errors]);
    await page.screenshot({ path: 'shot-1-empty.png', fullPage: true });
    await ctx.close();
  }

  // 2. RESULTS
  {
    const { page, ctx, errors } = await makePage();
    await page.fill('#city', 'Jaipur');
    await page.click('#go');
    await page.waitForSelector('#stateResults:not([hidden])', { timeout: 5000 });
    const summary = await page.textContent('#summaryLine');
    const cards = await page.locator('.day').count();
    const verdicts = await page.locator('.day-verdict').allTextContents();
    const packs = await page.locator('#packList .pack-name').allTextContents();
    const place = await page.textContent('#summaryPlace');
    results.push(['results state', cards === 5, errors]);
    console.log('\n--- RESULTS RENDER ---');
    console.log('place  :', place.trim());
    console.log('summary:', summary.trim());
    console.log('best   :', (await page.textContent('#summaryBest')).trim());
    verdicts.forEach((v, i) => console.log(`  day${i + 1}: ${v.trim()}`));
    console.log('packing:', packs.join(' | '));
    // verdict must be visually larger than the numbers
    const sizes = await page.evaluate(() => {
      const v = document.querySelector('.day-verdict');
      const s = document.querySelector('.day-stats');
      return [parseFloat(getComputedStyle(v).fontSize), parseFloat(getComputedStyle(s).fontSize)];
    });
    results.push([`hierarchy: verdict ${sizes[0]}px > numbers ${sizes[1]}px`, sizes[0] > sizes[1] + 3, []]);
    await page.screenshot({ path: 'shot-2-results.png', fullPage: true });
    await page.click('.method summary');
    await page.waitForTimeout(150);
    await page.screenshot({ path: 'shot-5-method.png', fullPage: true });
    await ctx.close();
  }

  // 3. DISAMBIGUATION
  {
    const { page, ctx, errors } = await makePage();
    await page.fill('#city', 'Springfield');
    await page.click('#go');
    await page.waitForSelector('#stateChoose:not([hidden])', { timeout: 5000 });
    const n = await page.locator('.choice').count();
    const first = (await page.locator('.choice').first().textContent()).replace(/\s+/g, ' ').trim();
    console.log('\n--- DISAMBIGUATION ---');
    console.log('options:', n, '| top (by population):', first);
    results.push(['disambiguation shows all 5', n === 5, errors]);
    await page.screenshot({ path: 'shot-3-choose.png', fullPage: true });
    // clicking one proceeds to results
    await page.locator('.choice').first().click();
    await page.waitForSelector('#stateResults:not([hidden])', { timeout: 5000 });
    results.push(['choice -> results', true, []]);
    await ctx.close();
  }

  // 4. ERROR: city not found
  {
    const { page, ctx, errors } = await makePage();
    await page.fill('#city', 'asdfghjkl');
    await page.click('#go');
    await page.waitForSelector('#stateError:not([hidden])', { timeout: 5000 });
    console.log('\n--- ERROR: not found ---');
    console.log((await page.textContent('#errorTitle')).trim());
    results.push(['not-found error', true, errors]);
    await page.screenshot({ path: 'shot-4-error.png', fullPage: true });
    await ctx.close();
  }

  // 5. ERROR: API 500
  {
    const { page, ctx, errors } = await makePage();
    await page.fill('#city', 'boomtown');
    await page.click('#go');
    await page.waitForSelector('#stateError:not([hidden])', { timeout: 5000 });
    console.log('\n--- ERROR: API failure ---');
    console.log((await page.textContent('#errorTitle')).trim(), '/', (await page.textContent('#errorBody')).trim().slice(0, 80));
    results.push(['api-failure error', true, errors]);
    await ctx.close();
  }

  // 6. Two-word city name must reach the forecast
  {
    const { page, ctx, errors } = await makePage();
    let requested = null;
    page.on('request', r => { if (r.url().includes('geocoding')) requested = r.url(); });
    await page.fill('#city', 'New Delhi');
    await page.click('#go');
    await page.waitForSelector('#stateResults:not([hidden])', { timeout: 5000 });
    console.log('\n--- TWO-WORD CITY ---');
    console.log('encoded request:', requested);
    results.push(['"New Delhi" encoded + resolved', /name=New(%20|\+)Delhi/.test(requested), errors]);
    await ctx.close();
  }

  // 7. Validation traps
  {
    const { page, ctx, errors } = await makePage();
    const cases = [
      ['', 'empty city'],
      ['x', 'one character'],
      ['12345', 'digits only']
    ];
    console.log('\n--- VALIDATION ---');
    for (const [val, label] of cases) {
      await page.fill('#city', val);
      await page.click('#go');
      await page.waitForTimeout(80);
      const msg = await page.textContent('#formError');
      const hidden = await page.locator('#formError').isHidden();
      console.log(`  ${label.padEnd(14)} -> ${hidden ? 'NO ERROR SHOWN' : msg.trim()}`);
      results.push([`validation: ${label}`, !hidden, []]);
    }
    // date past the 14-day horizon
    const far = new Date(); far.setDate(far.getDate() + 30);
    await page.fill('#city', 'Jaipur');
    await page.evaluate(v => {
      const e = document.getElementById('end');
      e.value = v; e.dispatchEvent(new Event('change'));
    }, far.toISOString().slice(0, 10));
    await page.click('#go');
    await page.waitForTimeout(120);
    const farMsg = await page.textContent('#formError');
    const farHidden = await page.locator('#formError').isHidden();
    console.log('  30 days ahead -> ' + (farHidden ? 'NO ERROR SHOWN' : farMsg.trim()));
    results.push(['validation: beyond 14-day horizon', !farHidden, errors]);
    const maxAttr = await page.getAttribute('#end', 'max');
    console.log('  end input max attribute:', maxAttr);
    await ctx.close();
  }

  // 8. Mobile viewport, no horizontal scroll
  {
    const { page, ctx, errors } = await makePage(390, 844);
    await page.fill('#city', 'Jaipur');
    await page.click('#go');
    await page.waitForSelector('#stateResults:not([hidden])', { timeout: 5000 });
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log('\n--- MOBILE 390px ---');
    console.log('horizontal overflow:', overflow, 'px');
    results.push(['mobile: no horizontal scroll', overflow <= 0, errors]);
    await page.screenshot({ path: 'shot-6-mobile.png', fullPage: true });
    await ctx.close();
  }

  await browser.close();

  console.log('\n' + '='.repeat(70));
  let bad = 0;
  results.forEach(([name, ok, errs]) => {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
    if (!ok) bad++;
    (errs || []).forEach(e => { console.log('        ! ' + e); bad++; });
  });
  console.log('='.repeat(70));
  console.log(bad === 0 ? 'All checks passed.' : bad + ' problem(s).');
  process.exit(bad === 0 ? 0 : 1);
})();
