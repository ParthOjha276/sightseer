# Sightseer: submission note

**Live:** https://sightseer-gilt.vercel.app/ · **Repo:** https://github.com/ParthOjha276/sightseer

## Who this advises

**The city sightseer.** I get between sights however I like, by taxi or metro or
on foot, and see the sights themselves by walking: 5–8 km across the day, in
stretches between 9am and 7pm. Stated in the first line of the interface.

I started from "someone who walks the city" and that was wrong, because nobody
walks a city continuously for ten hours. It matters because it decides what bad weather
costs: the sights, never the journeys. So advice like *keep the walking short*
charges the reader for a taxi they were always going to take.

## Workflow

```
city + dates
  [1] validate locally before spending a request: empty / 1-char / numeric city,
      end before start, start in the past, end beyond +14 days
  [2] GET geocoding-api…/search?name=…&count=5   name is encodeURIComponent'd,
      which is what stops "New Delhi" breaking.  0 → error · 1 → continue ·
      2+ → disambiguation, ranked by population, each row given the shortest
      label unique in that list. Never a silent pick, never two rows a person
      cannot tell apart.
  [3] GET api…/forecast   daily: temperature_2m_max/min, apparent_temperature_
      max/min, precipitation_probability_max, precipitation_sum, uv_index_max,
      wind_speed_10m_max, sunrise, sunset.  hourly: precipitation_probability,
      apparent_temperature.   non-200 / offline → error state, worded per cause
  [4] engine.js, pure and deterministic, no DOM or network: normalise → score
      five signals 0/1/2 → resolve conflicts into one sentence → re-read the
      thresholds hour by hour → aggregate to a summary and one packing list
  [5] results: verdict first, hours second, numbers last
```

Two requests per search, nothing cached or stored. Because `engine.js` touches
neither DOM nor network it runs against fixtures from the command line, which is
also how the copy got written: fifty verdicts side by side shows which sound like
a person and which sound like a template.

## Thresholds, and why

| Signal | Field | Worth a mention | Serious |
|---|---|---|---|
| Rain | `precipitation_probability_max`, `precipitation_sum` | 40–70%, or 2–10 mm | >70%, or >10 mm |
| Heat | `apparent_temperature_max` | 32–38 °C | >38 °C |
| Cold | `apparent_temperature_min` | 0–8 °C | <0 °C |
| Wind | `wind_speed_10m_max` | 25–40 km/h | >40 km/h |
| Sun | `uv_index_max` | 6–8 | >8 |

Apparent temperature, not raw: 34 °C in Chennai is not 34 °C in Jaipur. **32 °C**
is where walking starts costing water and shade; **38 °C** flips the advice from
"start early" to "not in the afternoon". **8 °C** is a mid-layer, **0 °C** gloves.
**25 km/h** makes umbrellas annoying, **40 km/h** makes open squares unpleasant.
**UV 6** is the WHO's "high" band.

When several fire at once severity wins, then **Rain → Heat → Cold → Wind → Sun**:
rain and thermal stress change *whether you go out*, wind and sun change *what you
wear*, and the sentence belongs to whichever changes the bigger call.

## The two rules I am most pleased with

**Off-hours rain.** A 90% chance at 3am is not a pedestrian's problem, but every
weather app flags it like rain at 2pm. Hourly probabilities are read *only* inside
9am–7pm; if the wettest walking hour is under 40% the day drops a level and says so.

**The walking window.** Inverting that gives the useful answer. The same
thresholds, re-read hour by hour and clipped to daylight, produce the hours worth
being outside: *"Clear until 10am. Too hot after that."* Only rain and temperature
can close an hour, for the reason they win the headline. A flat day gets no line,
because there is nothing to schedule around.

## What I deliberately left out

**Relative humidity as its own signal.** Available and obviously relevant, but
`apparent_temperature` already encodes it; surfacing both would double-count one
discomfort and let a muggy 30 °C day trip two warnings for one cause. Also cut:
cloud cover, wind direction (useless without a route), snowfall depth.

## What I would build next

**Something you can actually ask.** The engine already holds what a conversation
needs (five scored signals a day, the hours that work, the packing reasons) but
answers only the question it was asked. A chat layer over exactly that data would
let *"I only care about mornings"* or *"what if I shift a week later"* be answered
from the same deterministic rules, rather than a language model guessing at
weather. The judgement stays testable; the chat is only the interface to it.

## Stack, and AI use

Plain HTML, CSS and JS. No framework, build step, dependency or API key; Inter is
self-hosted so the page makes no third-party request. `test-fixtures.js` covers
the engine offline across six climates plus degenerate payloads, `ui-test.js`
walks all five states headlessly, `test.js` runs against the live API.

AI use was heavy, and it would be misleading to call it a light assist. The
product thinking is mine: persona, which signals matter, where the thresholds
sit, what to leave out. Each was worked out by proposing something, being pushed
back on, and changing my mind. Most of the code was written with AI against those
decisions, and I read the output rather than trusting it. The defects worth
naming are ones I caught that way: a heavy-rain day that said to pick indoor
things and *walk between them*, sending you into the rain it had just warned
about; three near-identical days given one copy-pasted sentence; a verdict
promising outdoor time directly above a line saying nothing opened up all day.
Each became a fix, and where it was a rule rather than a typo, a test.
