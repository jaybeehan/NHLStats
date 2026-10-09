# NHL Stats

Standings, schedule and strength of schedule, recent games, game logs, skater
and goalie advanced stats for any NHL team, on phone or desktop.

**Site:** https://jaybeehan.github.io/NHLStats/

## How it works

- `builder/build.py` downloads data from the NHL, Natural Stat Trick and
  MoneyPuck and writes JSON into `site/data/`. Python standard library only.
- `.github/workflows/build.yml` runs it every hour (scores, standings and
  per-game stats) and does a full rebuild once a day at 10:17 UTC, on every
  push, and on demand (Actions tab, "Build and publish site", Run workflow).
- `site/` is a static page (plain HTML, CSS and JavaScript) published with
  GitHub Pages. All 32 teams and the last three seasons are built, so switching
  team or season on the page is instant.

## Natural Stat Trick key

Expected goals, shot shares and skater stats need a Natural Stat Trick access
key, stored as a repository secret (never in the code):

Settings → Secrets and variables → Actions → New repository secret,
name `NST_KEY`, value: the key. Then run the workflow once.

## Data notes

- Goalie starts: Good when GSAx > 0.5, Bad when GSAx < -0.5, Mid otherwise.
- Strength of schedule is the average points % of opponents, using current
  standings (final standings for past seasons).
- Season length comes from the season: 84 games from 2026-27, 82 before
  (56 in 2020-21).
- Build notes (what loaded, what failed) appear as annotations on each
  workflow run.
