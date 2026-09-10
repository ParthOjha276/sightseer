# Sightseer — submission note

**Live link:** _(paste your deployed URL here)_
**Repo:** _(optional — paste if you publish it)_

---

## Who this advises

**The city sightseer.** They get between sights however they like, by taxi or
metro or on foot, and see the sights themselves by walking: 5–8 km across the
day, in stretches between 9am and 7pm, no specialist gear.

I started from "someone who walks the city" and it was the wrong persona, because
nobody walks a city continuously for ten hours. Defining one that way builds a
straw man and then calibrates thresholds to it. The real pattern is blocks: a
couple of hours around the old town, a metro or a taxi across the city, two more
hours somewhere else, dinner indoors. The sightseer is not someone who refuses
transport. Transport is simply not the part of their day the weather decides.

That distinction is the reason the hour-level window exists rather than being a
nice extra. If exposure were continuous, one verdict a day would cover it, and
"70% chance of rain" would be all you could usefully say. Because exposure comes
in blocks, the answerable question is *which* blocks, and a wet stretch from 2pm
to 5pm stops being a warning and turns into the slot you put the museum in.

None of the thresholds move because of this. Total distance and the daily window
are unchanged; what the refinement removes is a claim about continuity the
product was never really making.

I picked one user and built for them only. Advice for a trekker, a wedding guest
and a parent with a toddler are three different products, and a tool that tries
to serve all three ends up saying nothing to any of them. Every threshold below
is calibrated to the pedestrian and would be wrong for the other two. A trekker
would laugh at a 32 °C caution; a wedding guest cares about humidity ruining
their outfit, not about blister risk.

The persona is stated in the first line of the interface, so the user knows
whose advice they are reading.

---

## Workflow, in detail

```
city + date range
      │
      ▼
[1] validate locally ──────────────► reject before spending a request:
      │                              empty/1-char/numeric city, end before start,
      │                              start in the past, end beyond +14 days
      ▼
[2] GET geocoding-api.open-meteo.com/v1/search?name=…&count=5
      │   (name is encodeURIComponent'd, which is what stops "New Delhi" breaking)
      │
      ├─ 0 results ────────────────► ERROR STATE: "No city called X"
      ├─ 1 result  ────────────────► continue with it
      └─ 2+ results ───────────────► DISAMBIGUATION STATE
                                     ranked by population, and each row is
                                     labelled with the shortest description that
                                     is unique in that list. We never silently
                                     pick, and we never offer two rows a person
                                     cannot tell apart.
      ▼
[3] GET api.open-meteo.com/v1/forecast
      │   daily  = temperature_2m_max/min, apparent_temperature_max/min,
      │            precipitation_probability_max, precipitation_sum,
      │            uv_index_max, wind_speed_10m_max, sunrise, sunset
      │   hourly = precipitation_probability, apparent_temperature
      │   timezone=auto, start_date, end_date
      │
      ├─ non-200 / network down ───► ERROR STATE (offline, rate-limit and
      │                              generic failures worded differently)
      ▼
[4] engine.js — pure, deterministic, no DOM, no network
      │   a. normalise the columnar response into day rows
      │   b. compute the rain window from hourly data (9am–7pm only)
      │   c. score five signals 0/1/2 per day
      │   d. resolve conflicts into one headline plus secondary tags
      │   e. re-read the same thresholds hour by hour to find the hours
      │      worth being outside
      │   f. aggregate across days into a trip summary and packing list
      ▼
[5] RESULTS STATE — verdict first, hours second, numbers last
```

The judgement layer is a separate file with no DOM or network access, so it can
be run against fixtures from the command line (`node test-fixtures.js`). That is
also how the copy got written: I could read fifty verdicts side by side and see
which ones sounded like a person and which sounded like a template.

**Requests per search:** two. No polling, no caching, no stored responses. Every
number on screen came from a request made after you pressed the button.

---

## Thresholds, and why these numbers

| Signal | Field | Worth a mention | Serious |
|---|---|---|---|
| Rain | `precipitation_probability_max`, `precipitation_sum` | 40–70%, or 2–10 mm | >70%, or >10 mm |
| Heat | `apparent_temperature_max` | 32–38 °C | >38 °C |
| Cold | `apparent_temperature_min` | 0–8 °C | <0 °C |
| Wind | `wind_speed_10m_max` | 25–40 km/h | >40 km/h |
| Sun | `uv_index_max` | 6–8 | >8 |

**Why apparent temperature, not raw.** A walker feels humidity and wind, not the
thermometer. 34 °C in Chennai and 34 °C in Jaipur are different days, and
`apparent_temperature` is the field that already knows that.

**32 °C** is where continuous walking stops being pleasant and starts costing
water and shade planning. **38 °C** is where the advice flips from "start early"
to "do not do this in the afternoon". **8 °C** is a mid-layer; **0 °C** is gloves
and shortened stretches. **25 km/h** is when loose clothing and umbrellas become
annoying; **40 km/h** is when open squares and bridges become unpleasant.
**UV 6** is the WHO's "high" band, which is also where a fair-skinned person
walking unshaded for hours starts to burn.

**Conflict resolution.** When several signals fire on one day, severity wins
first; ties break in this order:

> **Rain → Heat → Cold → Wind → Sun**

Rain and thermal stress change *whether you go out*. Wind and sun change *what
you wear*. The single verdict sentence belongs to the signal that changes the
bigger decision; everything else drops to a small tag under it. So a 39 °C day
with 75% rain reads as a rain day, because you will cancel the walk either way,
and rain is the thing that makes the cancellation unavoidable.

**The rule I am most pleased with: off-hours rain.** A 90% chance of rain at 3am
is not a pedestrian's problem, but every weather app flags it identically to rain
at 2pm. So the hourly probabilities are read *only* inside 9am–7pm. If the
wettest walking hour is under 40%, the day is scored one level lower and the
verdict says so explicitly: *"Rain on the books, but almost all of it lands
outside walking hours."*

---

## The walking window

The off-hours rule above throws away rain that misses you. Inverting it gives
something more useful: the hours that are actually worth being outside.

Every hour between sunrise and sunset, clipped to 9am–7pm, is scored against the
**same thresholds as the daily pass**. An hour is shut at >70% rain or a
feels-like above 38 °C or below 0 °C, and awkward at 50% rain or the 32 °C / 8 °C
marks. Reusing the daily numbers matters: the day-level verdict and the
hour-level plan can never disagree about what counts as a problem.

Only rain and temperature can close an hour, for exactly the reason they win the
headline. Wind and sun change what you wear, so they change nothing about *when*
you go, and letting them shut an hour would have been double-counting.

What comes out sits under the verdict on each card:

> Clear until 10am. Too hot after that.
> Too cold until 11am. Easiest after that.
> Clear until 2pm. Wet 2 to 6pm.

Three decisions inside that are worth defending:

**A day with no shape gets no plan line.** If every hour of a day is equally
warm, there is nothing to schedule around, and printing "easiest 9am to 7pm"
would be noise dressed as advice. The line only appears when the day has a
contrast to describe.

**A single clear hour is not a plan.** One dry hour inside a wet afternoon is
forecast noise. Isolated good hours are discarded unless they are all the day
has, in which case the day is described as *easiest*, never *clear*, because
overclaiming here costs someone a soaking.

**It reads in the order the day happens.** "Easiest after 11am. Too cold until
11am." is accurate and still backwards. Where the bad stretch comes first, it is
said first.

---

## Two rules the persona imposes on the advice

Changing the persona from "someone who walks the city" to the sightseer did not
move a single threshold, but it invalidated a whole class of the advice, and
finding out why was the most useful hour I spent on this.

**Transport is free.** This user gets between sights however they like. So bad
weather costs them the sights themselves and never the journeys, and any
sentence that charges them for a journey is wrong. The build had several. The
worst was a heavy-rain day that read:

> Wet from end to end again. Pick the indoor things today and walk between them.

which sends the reader out into the rain it has just warned them about. Others
were quieter but the same mistake: *keep the walking short*, *pick things you can
reach without getting soaked*, *anything outdoors needs to be short and close to
shelter*. All of them assume the walk between places is unavoidable. It is not.
What a wet day actually costs a sightseer is the outdoor half of the itinerary,
so the useful reply is which half survives and what to do with the rest. The
same day now reads:

> Heavy rain with no clean gap in it. Make it an indoor day, and get between
> sights by taxi or metro rather than on foot.

**The window has the last word.** The verdict is computed from the daily scores;
the plan line under it is computed from the hourly pass. Nothing was stopping
those two from disagreeing, and on the right day they did:

> Heavy rain today. Do the outdoor half early and keep something indoors in reserve.
> Clear hours: nothing opens up between 9am and 7pm.

That needs a specific shape of day to trigger: severe heat sealing every hour so
the window is shut, while the rain falls only in an afternoon block, so rain
still wins the headline on priority. The daily pass sees a rain day with a
morning; the hourly pass knows the morning is 41 °C.

The fix was to give the window a shape the verdict has to read first. **Open** is
a day you can spend outside. **Split** has a usable stretch and a write-off, and
gets told to put the outdoor sights in the gap. **Shut** means no clean stretch
exists, and gets indoor advice. A fourth state, uniformly mediocre with nothing
to schedule around, gets no special sentence, because there is nothing to say.

Both rules are asserted in `test-fixtures.js` rather than left to my judgement:
one test builds the sealed-by-heat-led-by-rain day and fails if the verdict
promises outdoor time the plan has ruled out; another sweeps three climates and
fails if any verdict tells this persona to walk between sights.

A note on "shut". It means no *clean* hour, not no hour at all, so the copy is
careful never to claim totality. A day whose least-bad hour is 34 °C still gets
"nothing cool enough to be out in for long" rather than "nothing opens up",
because the plan line beneath it is still offering that hour, and the two must
not argue in front of the reader.

---

## Unremarkable days, and repetition

Most days are unremarkable, and "partly cloudy, 26 °C" is a non-answer. A calm
day still has to earn its card, so it gets one actionable fact instead: a
superlative relative to the rest of *this* trip ("your best walking day",
"comfortably the warmest", "the coolest day you get"), or the daylight window.
Daylight is printed once per trip, not on every card, because sunrise barely
moves across five days and four cards ending in the same sentence is worse than
three cards ending in nothing.

The harder version of the same problem is three genuinely similar days. A trip to
Jaipur can hand you three 37 °C afternoons in a row, and the first build answered
all three with one sentence, copy-pasted. The fix was not to reword it three
ways. Each day is checked for what makes it *itself* first: whether it is the
trip's hottest or coldest or wettest, whether it cools off at night, whether the
cold is a morning problem or an all-day one. Only when two days really are alike
does the engine reach for a different piece of advice rather than a reworded
version of the same one, so the third hot day talks about shade and pace where
the first talked about starting early. `node test-fixtures.js` asserts that three
identical inputs produce three distinct verdicts.

---

## Packing list

Set-union across all days, deduplicated, and deliberately **conditional only**. A
packing list that tells you to bring a phone charger has told you nothing. Every
line names the signal that put it there ("UV peaks at 10").

Three dedup rules worth mentioning: a windbreaker is suppressed when a rain shell
is already listed, because the shell does that job; the day/night swing rule
fires on the trip's maximum swing rather than per day, so it appears once; and
"something to fill an afternoon indoors" is gated on hours the window found
genuinely shut, not on days where it merely might rain, because those are
different claims.

The only unconditional items are the two the *persona* implies, walking shoes and
blister plasters, and they are visually separated under "because you're on foot".

---

## What I deliberately left out

**Relative humidity as its own signal.** It is available, it is obviously
relevant to comfort, and I do not surface it, because `apparent_temperature`
already encodes it. Showing both would double-count the same discomfort and let a
muggy 30 °C day trip two separate warnings for one underlying cause. Humidity is
in the verdict; it just arrives through the feels-like number rather than as a
line of its own.

Also cut, more briefly: cloud cover and sunshine duration (a walker does not
change plans for overcast), wind direction (useless without a route), and
snowfall depth (out of scope for a city-walking product).

---

## What I would build next

**Switchable personas.** Right now the judgement layer is invisible: you see its
output and have to trust it. Letting the user swap pedestrian for trekker,
toddler-in-tow or wedding guest, and watching every threshold and every verdict
move, would make the reasoning the actual product rather than something hidden
behind one default. The thresholds already live in a single object, so the work
is a UI and a second calibration, not a rewrite.

**"When should I go", instead of "how is this looking".** The walking window
already knows how many good hours each day has. Given a city and a loose month
rather than fixed dates, the same numbers would rank the days and answer a
question people ask earlier in a trip than the one this app currently answers.

---

## Stack, honestly

Plain HTML, CSS and JavaScript. No framework, no build step, no dependencies, no
API key. Four files, a font, and a static host.

Structure is deliberate: `engine.js` holds all judgement as pure functions with
no DOM or network access, `app.js` holds fetch/validation/rendering, and
`styles.css` is separate. That split is what made the logic testable offline
(`test-fixtures.js` covers calm / afternoon rain / off-hours rain / four-way
conflict / cold / desert / near-identical days / a hot day with a walkable
morning, plus null and empty payloads) and browser-testable headlessly
(`ui-test.js` walks all five states, checks the two-word city name is encoded,
and asserts the page does not scroll sideways at 390px).

Inter is self-hosted in `fonts/` rather than loaded from a CDN, so the "no key,
no cache, nothing stored" line in the footer stays true of the whole page and not
just the forecast.

## On AI use

Heavy, and it would be misleading to call it a light assist.

The product thinking is mine. Who this advises, which five signals matter and
which to leave out, where the thresholds sit, what an unremarkable day should
say, what happens when several things go wrong at once: those were decided by
arguing them through, proposing something, getting pushed back on, and changing
my mind more than once. The persona is the clearest example. I started from
"someone who walks the city", realised nobody walks a city continuously for ten
hours, and reframed it around the sightseer, which then invalidated a chunk of
the advice copy and had to be chased back through the engine.

Most of the code was written with AI against those decisions, and I reviewed
what came back rather than taking it on trust. The defects worth naming were
ones I caught reading the output: a heavy-rain day that told you to pick indoor
things and *walk between them*, which sends you into the rain it had just warned
about; three near-identical days answered with one sentence copy-pasted; a
verdict promising outdoor time directly above a plan line saying nothing opens
up all day. Each of those became a fix and, where it was a rule rather than a
typo, a test in `test-fixtures.js`.

If you want to probe any of it, `engine.js` is the place. Every decision above is
written down and defended there, and it runs from the command line without a
browser.
