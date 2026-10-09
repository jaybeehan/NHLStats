#!/usr/bin/env python3
"""
Builds the JSON data behind the NHLStats website.

Runs on GitHub Actions (see .github/workflows/build.yml). Standard library only.

Sources
  NHL (api-web.nhle.com, api.nhle.com)   standings, schedules, scores, skater totals
  Natural Stat Trick (data site, needs a key in the NST_KEY secret)
                                         per-game team stats, skater advanced stats
  MoneyPuck                              goalie season stats and game-by-game logs

Modes
  full   everything for the current season, plus any past season not built yet
  light  current season standings, scores and per-game team stats only;
         everything else is carried over from the published site
  auto   full once a day (10:00 UTC run) or when nothing is published yet

Output: site/data/manifest.json and site/data/<season>/*.json
"""

import csv
import datetime as dt
import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

NHL = "https://api-web.nhle.com/v1/"
STATS = "https://api.nhle.com/stats/rest/en/"
NST = "https://data.naturalstattrick.com/"
MP = "https://moneypuck.com/moneypuck/playerData/"

OUT = os.path.join(os.path.dirname(__file__), "..", "site", "data")
SITE_URL = os.environ.get("SITE_URL", "").rstrip("/")
NST_KEY = os.environ.get("NST_KEY", "").strip()
MODE = os.environ.get("MODE", "auto").strip() or "auto"
SEASONS_BACK = 2  # past seasons to offer besides the current one

SEASON_GAMES = {
    20262027: 84, 20252026: 82, 20242025: 82, 20232024: 82, 20222023: 82,
    20212022: 82, 20202021: 56, 20192020: 82, 20182019: 82,
}

# NST spells a few teams its own way; map every spelling to the NHL code.
NST_TEAM_NAMES = {
    "Anaheim Ducks": "ANA", "Arizona Coyotes": "ARI", "Boston Bruins": "BOS",
    "Buffalo Sabres": "BUF", "Calgary Flames": "CGY", "Carolina Hurricanes": "CAR",
    "Chicago Blackhawks": "CHI", "Colorado Avalanche": "COL",
    "Columbus Blue Jackets": "CBJ", "Dallas Stars": "DAL", "Detroit Red Wings": "DET",
    "Edmonton Oilers": "EDM", "Florida Panthers": "FLA", "Los Angeles Kings": "LAK",
    "Minnesota Wild": "MIN", "Montreal Canadiens": "MTL", "Montréal Canadiens": "MTL",
    "Nashville Predators": "NSH", "New Jersey Devils": "NJD",
    "New York Islanders": "NYI", "New York Rangers": "NYR", "Ottawa Senators": "OTT",
    "Philadelphia Flyers": "PHI", "Pittsburgh Penguins": "PIT", "San Jose Sharks": "SJS",
    "Seattle Kraken": "SEA", "St Louis Blues": "STL", "St. Louis Blues": "STL",
    "Tampa Bay Lightning": "TBL", "Toronto Maple Leafs": "TOR", "Utah Mammoth": "UTA",
    "Utah Hockey Club": "UTA", "Utah HC": "UTA", "Vancouver Canucks": "VAN",
    "Vegas Golden Knights": "VGK", "Washington Capitals": "WSH", "Winnipeg Jets": "WPG",
}
NST_TEAM_CODES = {"N.J": "NJD", "S.J": "SJS", "T.B": "TBL", "L.A": "LAK"}

notes = []


def note(msg, level="notice"):
    """Shows up as an annotation on the GitHub Actions run."""
    notes.append(msg)
    print(f"::{level}::{msg}", flush=True)


# ------------------------------------------------------------------ fetching

def fetch(url, headers=None, tries=3, timeout=60):
    h = {"User-Agent": "NHLStats site builder (github.com/jaybeehan/NHLStats)"}
    h.update(headers or {})
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (400, 401, 403, 404):
                break
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(2 * (i + 1))
    raise RuntimeError(f"{url.split('?')[0]}: {last}")


def fetch_json(url):
    return json.loads(fetch(url))


def nst(page, params):
    if not NST_KEY:
        raise RuntimeError("no NST_KEY secret")
    time.sleep(1.5)  # be polite to NST
    return fetch(NST + page + "?" + urllib.parse.urlencode(params),
                 headers={"nst-key": NST_KEY}, timeout=120)


# ------------------------------------------------------------- html tables

def clean(cell):
    cell = re.sub(r"<script\b.*?</script>|<style\b.*?</style>", "", cell, flags=re.S | re.I)
    cell = re.sub(r"<[^>]*>", " ", cell)
    cell = (cell.replace("&nbsp;", " ").replace("&#160;", " ").replace("&amp;", "&")
            .replace("&quot;", '"').replace("&#39;", "'").replace("&apos;", "'"))
    return re.sub(r"\s+", " ", cell).strip()


def parse_rows(html):
    rows = []
    for tr in re.findall(r"<tr\b[^>]*>.*?</tr>", html, flags=re.S | re.I):
        cells = re.findall(r"<(?:th|td)\b[^>]*>.*?</(?:th|td)>", tr, flags=re.S | re.I)
        rows.append([clean(c) for c in cells])
    return rows


def find_table(html, required):
    """Header row containing all `required` names, plus the rows under it."""
    def build(rows):
        idx = next((i for i, r in enumerate(rows) if all(n in r for n in required)), -1)
        if idx < 0:
            return None
        head = rows[idx]
        body = [r for r in rows[idx + 1:] if len(r) > 1 and not all(n in r for n in required)]
        body = [(r + [""] * len(head))[:len(head)] for r in body]
        return head, body

    for t in re.findall(r"<table\b.*?</table>", html, flags=re.S | re.I):
        got = build(parse_rows(t))
        if got and got[1]:
            return got
    got = build(parse_rows(html))  # header and rows split across tables
    if got:
        return got
    title = re.search(r"<title[^>]*>(.*?)</title>", html, flags=re.S | re.I)
    raise RuntimeError(f"table with {required} not found (page '{clean(title.group(1)) if title else '?'}', {len(html)} chars)")


def num(v):
    try:
        return float(str(v).replace(",", "").strip())
    except ValueError:
        return None


def rnd(v, d=2):
    return None if v is None else round(v, d)


# ------------------------------------------------------------------ seasons

def current_season(today=None):
    today = today or dt.date.today()
    start = today.year if today.month >= 9 else today.year - 1
    return start * 10000 + start + 1


def label(season):
    s = str(season)
    return f"{s[:4]}-{s[6:]}"


# ------------------------------------------------------------- NHL sources

def nhl_standings(season, is_current):
    date = "now"
    if not is_current:
        seasons = fetch_json(NHL + "standings-season").get("seasons", [])
        match = next((x for x in seasons if x.get("id") == season), None)
        if match:
            date = match.get("standingsEnd") or date
    raw = fetch_json(NHL + f"standings/{date}").get("standings", [])
    out = []
    for t in raw:
        def g(k, d=0):
            v = t.get(k, d)
            return v.get("default") if isinstance(v, dict) else v
        out.append({
            "team": g("teamAbbrev"), "name": g("teamName"), "nick": g("teamCommonName"),
            "conf": g("conferenceName"), "div": g("divisionName"),
            "gp": g("gamesPlayed"), "w": g("wins"), "l": g("losses"), "otl": g("otLosses"),
            "pts": g("points"), "pct": g("pointPctg"),
            "rw": g("regulationWins"), "row": g("regulationPlusOtWins"),
            "gf": g("goalFor"), "ga": g("goalAgainst"),
            "home": f"{g('homeWins')}-{g('homeLosses')}-{g('homeOtLosses')}",
            "road": f"{g('roadWins')}-{g('roadLosses')}-{g('roadOtLosses')}",
            "l10": f"{g('l10Wins')}-{g('l10Losses')}-{g('l10OtLosses')}",
            "streak": f"{g('streakCode', '')}{g('streakCount', '')}",
            "logo": g("teamLogo", ""),
        })
    if len(out) < 30:
        raise RuntimeError(f"standings returned {len(out)} teams")
    return {"date": date, "teams": out}


def game_row(g, date=None):
    final = g.get("gameState") in ("OFF", "FINAL")
    live = g.get("gameState") in ("LIVE", "CRIT")
    home, away = g.get("homeTeam", {}), g.get("awayTeam", {})
    outcome = g.get("gameOutcome") or {}
    return [
        g["id"], date or g.get("gameDate", ""), g.get("startTimeUTC", ""),
        away.get("abbrev"), home.get("abbrev"), g.get("gameState", ""),
        away.get("score") if (final or live) else None,
        home.get("score") if (final or live) else None,
        outcome.get("lastPeriodType", "") if final else "",
    ]


SCHEDULE_COLS = ["id", "date", "start", "away", "home", "state", "as", "hs", "ended"]


def nhl_schedule(season, teams):
    games = {}
    for abbr in teams:
        try:
            data = fetch_json(NHL + f"club-schedule-season/{abbr}/{season}")
        except Exception as e:  # noqa: BLE001
            note(f"{label(season)} schedule for {abbr} failed: {e}", "warning")
            continue
        for g in data.get("games", []):
            if g.get("gameType") == 2 and g["id"] not in games:
                games[g["id"]] = game_row(g)
    rows = sorted(games.values(), key=lambda r: r[2])
    if not rows:
        raise RuntimeError("no games found")
    return {"cols": SCHEDULE_COLS, "games": rows}


def nhl_week(schedule):
    """Merge the NHL's current week (3 days back, 3 ahead) into a schedule."""
    start = (dt.date.today() - dt.timedelta(days=3)).isoformat()
    week = fetch_json(NHL + f"schedule/{start}").get("gameWeek", [])
    by_id = {r[0]: r for r in schedule["games"]}
    n = 0
    for day in week:
        for g in day.get("games", []):
            if g.get("gameType") == 2:
                by_id[g["id"]] = game_row(g, day.get("date"))
                n += 1
    schedule["games"] = sorted(by_id.values(), key=lambda r: r[2])
    return n


def nhl_skaters(season):
    """Every skater's season totals, with NHL player IDs (used for links)."""
    q = urllib.parse.urlencode({
        "limit": -1, "start": 0, "sort": "points",
        "cayenneExp": f"seasonId={season} and gameTypeId=2",
    })
    data = fetch_json(STATS + "skater/summary?" + q).get("data", [])
    cols = ["id", "name", "teams", "pos", "gp", "g", "a", "p", "pm", "pim", "ppp", "shots", "toi"]
    rows = []
    for p in data:
        rows.append([
            p.get("playerId"), p.get("skaterFullName"), p.get("teamAbbrevs") or "",
            p.get("positionCode"), p.get("gamesPlayed"), p.get("goals"), p.get("assists"),
            p.get("points"), p.get("plusMinus"), p.get("penaltyMinutes"), p.get("ppPoints"),
            p.get("shots"), rnd((p.get("timeOnIcePerGame") or 0) / 60, 2),
        ])
    return {"cols": cols, "rows": rows}


# -------------------------------------------------------------- NST sources

TEAMGAME_STATS = ["TOI", "CF", "CA", "FF", "FA", "SF", "SA", "GF", "GA",
                  "xGF", "xGA", "SCF", "SCA", "HDCF", "HDCA"]


def nst_team_games(season):
    """Every team's per-game totals, all situations and 5v5."""
    out = {"cols": ["date", "team", "sit"] + TEAMGAME_STATS, "rows": []}
    unknown = set()
    for sit in ("all", "5v5"):
        html = nst("games.php", {
            "fromseason": season, "thruseason": season, "stype": 2, "sit": sit,
            "loc": "B", "team": "All", "team2": "All", "rate": "n"})
        head, body = find_table(html, ["Game", "Team", "GF", "GA", "xGF", "xGA"])
        ix = {n: head.index(n) for n in head}
        for r in body:
            name = r[ix["Team"]]
            team = NST_TEAM_NAMES.get(name)
            if not team:
                unknown.add(name)
                continue
            date = r[ix["Game"]][:10]
            stats = [rnd(num(r[ix[c]])) if c in ix else None for c in TEAMGAME_STATS]
            out["rows"].append([date, team, sit] + stats)
    if unknown:
        note(f"{label(season)}: NST team names not recognised: {', '.join(sorted(unknown))}", "warning")
    return out


SKATER_STD = {"Position": "pos", "GP": "gp", "TOI": "toi", "Goals": "g",
              "Total Assists": "a", "Total Points": "p", "ixG": "ixg", "iHDCF": "ihdcf",
              "Shots": "sog", "iCF": "icf"}
SKATER_OI = {"CF%": "cf", "xGF%": "xgf", "HDCF%": "hdcf", "GF%": "gfp",
             "On-Ice SH%": "oish", "On-Ice SV%": "oisv", "PDO": "pdo",
             "Off. Zone Start %": "ozs"}


def nst_skaters(season):
    cols = ["sit", "name", "team"] + list(SKATER_STD.values()) + list(SKATER_OI.values())
    out = {"cols": cols, "rows": []}
    missing = set()
    for sit in ("5v5", "all", "ev", "pp", "pk"):
        def page(stdoi):
            return nst("playerteams.php", {
                "fromseason": season, "thruseason": season, "stype": 2, "sit": sit,
                "score": "all", "stdoi": stdoi, "rate": "n", "team": "ALL", "pos": "S",
                "loc": "B", "toi": 0, "gpfilt": "none", "fd": "", "td": "",
                "tgp": 410, "lines": "single", "draftteam": "ALL"})
        try:
            sh, sb = find_table(page("std"), ["Player", "GP", "TOI"])
            oh, ob = find_table(page("oi"), ["Player", "GP", "TOI"])
        except Exception as e:  # noqa: BLE001
            note(f"{label(season)} skaters {sit} failed: {e}", "warning")
            continue
        si = {n: sh.index(n) for n in sh}
        oi = {n: oh.index(n) for n in oh}
        missing |= {k for k in SKATER_STD if k not in si} | {k for k in SKATER_OI if k not in oi}
        team_of = lambda r, ix: r[ix["Team"]] if "Team" in ix else ""  # noqa: E731
        on_ice = {(r[oi["Player"]], team_of(r, oi)): r for r in ob}
        for r in sb:
            name, teams = r[si["Player"]], team_of(r, si)
            if not name:
                continue
            o = on_ice.get((name, teams), [])
            codes = ", ".join(NST_TEAM_CODES.get(t.strip(), t.strip()) for t in teams.split(",") if t.strip())
            vals = []
            for k in SKATER_STD:
                v = r[si[k]] if k in si else ""
                vals.append(v if k == "Position" else rnd(num(v)))
            for k in SKATER_OI:
                v = o[oi[k]] if (k in oi and o) else ""
                vals.append(rnd(num(v), 3 if k == "PDO" else 2))
            out["rows"].append([sit, name, codes] + vals)
    if missing:
        note(f"{label(season)} skaters: NST columns not found: {', '.join(sorted(missing))}", "warning")
    if not out["rows"]:
        raise RuntimeError("no skater rows")
    return out


# ---------------------------------------------------------- MoneyPuck sources

def mp_csv(url):
    return list(csv.DictReader(io.StringIO(fetch(url, timeout=90))))


GOALIE_COLS = ["id", "name", "team", "sit", "gp", "toi", "xga", "ga", "sa",
               "hdxga", "hdga", "hdsa"]


def mp_goalies(season):
    rows = mp_csv(MP + f"seasonSummary/{str(season)[:4]}/regular/goalies.csv")
    out = []
    for r in rows:
        out.append([
            int(r["playerId"]), r["name"], r["team"], r["situation"],
            int(float(r["games_played"] or 0)), rnd(num(r["icetime"]) / 60, 1),
            rnd(num(r["xGoals"])), rnd(num(r["goals"]), 0), rnd(num(r["ongoal"]), 0),
            rnd(num(r.get("highDangerxGoals"))), rnd(num(r.get("highDangerGoals")), 0),
            rnd(num(r.get("highDangerShots")), 0),
        ])
    if not out:
        raise RuntimeError("no goalie rows")
    return {"cols": GOALIE_COLS, "rows": out}


GLOG_COLS = ["date", "id", "name", "team", "opp", "ha", "sit", "toi", "sa", "ga",
             "xga", "hdsa", "hdga", "hdxga"]


def mp_goalie_games(ids, seasons):
    """Game-by-game rows for each goalie, split by season. Career files are per
    goalie, so one download covers every season."""
    by_season = {s: [] for s in seasons}
    starts = {str(s)[:4]: s for s in seasons}
    failed = 0
    for pid in sorted(ids):
        try:
            rows = mp_csv(MP + f"careers/gameByGame/regular/goalies/{pid}.csv")
        except Exception:  # noqa: BLE001
            failed += 1
            continue
        for r in rows:
            s = starts.get(str(r.get("season", "")))
            if not s or r.get("situation") == "other":
                continue
            toi = num(r.get("icetime")) or 0
            if toi <= 0:
                continue
            d = str(r.get("gameDate", ""))
            by_season[s].append([
                f"{d[:4]}-{d[4:6]}-{d[6:8]}", pid, r.get("name"), r.get("playerTeam"),
                r.get("opposingTeam"), "H" if r.get("home_or_away") == "HOME" else "A",
                r.get("situation"), rnd(toi / 60, 1), rnd(num(r.get("ongoal")), 0),
                rnd(num(r.get("goals")), 0), rnd(num(r.get("xGoals")), 3),
                rnd(num(r.get("highDangerShots")), 0), rnd(num(r.get("highDangerGoals")), 0),
                rnd(num(r.get("highDangerxGoals")), 3),
            ])
        time.sleep(0.3)
    if failed:
        note(f"goalie game logs: {failed} of {len(ids)} goalies could not be downloaded", "warning")
    return {s: {"cols": GLOG_COLS, "rows": rows} for s, rows in by_season.items()}


# -------------------------------------------------------------- persistence

def season_dir(season):
    d = os.path.join(OUT, str(season))
    os.makedirs(d, exist_ok=True)
    return d


def save(season, name, data):
    with open(os.path.join(season_dir(season), name + ".json"), "w") as f:
        json.dump(data, f, separators=(",", ":"), ensure_ascii=False)


def load_prev(season, name):
    """The published copy of a data file, or None."""
    if not SITE_URL:
        return None
    try:
        return fetch_json(f"{SITE_URL}/data/{season}/{name}.json")
    except Exception:  # noqa: BLE001
        return None


def step(season, name, fn, prev_manifest, required=False):
    """Run one data step; on failure keep the published copy if there is one."""
    try:
        data = fn()
        save(season, name, data)
        return True
    except Exception as e:  # noqa: BLE001
        prev = load_prev(season, name) if prev_manifest else None
        if prev is not None:
            save(season, name, prev)
            note(f"{label(season)} {name}: {e}; kept the previous copy", "warning")
            return True
        note(f"{label(season)} {name}: {e}", "error" if required else "warning")
        return False


# --------------------------------------------------------------------- main

def main():
    os.makedirs(OUT, exist_ok=True)
    cur = current_season()
    seasons = [cur]
    for _ in range(SEASONS_BACK):
        s = seasons[-1]
        start = s // 10000 - 1
        seasons.append(start * 10000 + start + 1)

    prev_manifest = None
    if SITE_URL:
        try:
            prev_manifest = fetch_json(f"{SITE_URL}/data/manifest.json")
        except Exception:  # noqa: BLE001
            prev_manifest = None
    prev_built = {s["code"]: s for s in (prev_manifest or {}).get("seasons", [])}

    mode = MODE
    if mode == "auto":
        mode = "full" if (dt.datetime.utcnow().hour == 10 or not prev_manifest) else "light"
    note(f"mode {mode}; seasons {', '.join(label(s) for s in seasons)}; NST key {'set' if NST_KEY else 'missing'}")

    files = ["standings", "schedule", "teamgames", "skaters", "leaders", "goalies", "goaliegames"]
    manifest = {"generated": dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
                "mode": mode, "current": cur, "nst": bool(NST_KEY), "seasons": [], "notes": notes}

    goalie_ids = {}
    for season in seasons:
        is_cur = season == cur
        prev = prev_built.get(season)
        # Past seasons don't change: carry them over once they are complete.
        reuse_all = (not is_cur and prev and prev.get("complete")) or (mode == "light" and prev)
        have = {}
        if reuse_all:
            for name in files:
                data = load_prev(season, name)
                if data is not None:
                    save(season, name, data)
                    have[name] = True
        teams = []

        if is_cur or not reuse_all:
            ok = step(season, "standings", lambda: nhl_standings(season, is_cur), prev, True)
            have["standings"] = ok or have.get("standings", False)
            try:
                with open(os.path.join(season_dir(season), "standings.json")) as f:
                    teams = [t["team"] for t in json.load(f)["teams"]]
            except Exception:  # noqa: BLE001
                teams = []

        if is_cur and mode == "light" and have.get("schedule"):
            try:
                with open(os.path.join(season_dir(season), "schedule.json")) as f:
                    sched = json.load(f)
                n = nhl_week(sched)
                save(season, "schedule", sched)
                note(f"{label(season)}: refreshed {n} games this week")
            except Exception as e:  # noqa: BLE001
                note(f"{label(season)} week schedule: {e}", "warning")
            have["teamgames"] = step(season, "teamgames", lambda: nst_team_games(season), prev) or have.get("teamgames")
        elif not reuse_all or is_cur:
            def sched_fn():
                sch = nhl_schedule(season, teams)
                if is_cur:
                    nhl_week(sch)
                return sch
            have["schedule"] = step(season, "schedule", sched_fn, prev, True)
            have["teamgames"] = step(season, "teamgames", lambda: nst_team_games(season), prev)
            have["skaters"] = step(season, "skaters", lambda: nst_skaters(season), prev)
            have["leaders"] = step(season, "leaders", lambda: nhl_skaters(season), prev)
            have["goalies"] = step(season, "goalies", lambda: mp_goalies(season), prev)
            if have["goalies"]:
                with open(os.path.join(season_dir(season), "goalies.json")) as f:
                    goalie_ids[season] = {r[0] for r in json.load(f)["rows"]}

        manifest["seasons"].append({
            "code": season, "label": label(season), "games": SEASON_GAMES.get(season, 82),
            "current": is_cur, "files": sorted(k for k, v in have.items() if v),
        })

    # Goalie game logs: one download per goalie covers all seasons that need it.
    if goalie_ids:
        all_ids = set().union(*goalie_ids.values())
        logs = mp_goalie_games(all_ids, list(goalie_ids))
        for season, data in logs.items():
            save(season, "goaliegames", data)
            entry = next(x for x in manifest["seasons"] if x["code"] == season)
            entry["files"] = sorted(set(entry["files"]) | {"goaliegames"})
        note(f"goalie game logs: {len(all_ids)} goalies")

    for entry in manifest["seasons"]:
        entry["complete"] = set(files) <= set(entry["files"])
        note(f"{entry['label']}: {', '.join(entry['files']) or 'nothing'}")

    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    if not any(s["files"] for s in manifest["seasons"]):
        sys.exit("no data could be built")


if __name__ == "__main__":
    main()
