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
import xml.etree.ElementTree as ET
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
# Bump when the meaning of a data file changes, so past seasons rebuild once.
DATA_VERSION = 2

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
    """Number from a table cell. Times like '58:23' (or '1:02:05') become minutes."""
    t = str(v).replace(",", "").strip()
    if re.fullmatch(r"\d+(:\d{1,2}){1,2}", t):
        parts = [int(x) for x in t.split(":")]
        if len(parts) == 3:
            return parts[0] * 60 + parts[1] + parts[2] / 60
        return parts[0] + parts[1] / 60
    try:
        return float(t)
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


TEAM_SUMMARY = {
    "gp": "gamesPlayed", "gf": "goalsFor", "ga": "goalsAgainst",
    "gfpg": "goalsForPerGame", "gapg": "goalsAgainstPerGame",
    "pp": "powerPlayPct", "pk": "penaltyKillPct",
    "ppnet": "powerPlayNetPct", "pknet": "penaltyKillNetPct",
    "sfpg": "shotsForPerGame", "sapg": "shotsAgainstPerGame", "fo": "faceoffWinPct",
}


def nhl_team_summary(season, name_to_code):
    """Special teams, shots and faceoffs for every team (NHL stats API)."""
    q = urllib.parse.urlencode({
        "limit": -1, "cayenneExp": f"seasonId={season} and gameTypeId=2"})
    data = fetch_json(STATS + "team/summary?" + q).get("data", [])
    cols = ["team"] + list(TEAM_SUMMARY)
    rows, unknown = [], []
    for t in data:
        name = t.get("teamFullName", "")
        code = name_to_code.get(name) or NST_TEAM_NAMES.get(name)
        if not code:
            unknown.append(name)
            continue
        rows.append([code] + [t.get(v) for v in TEAM_SUMMARY.values()])
    if unknown:
        note(f"{label(season)} team summary: names not recognised: {', '.join(unknown)}", "warning")
    if not rows:
        raise RuntimeError("no team summary rows")
    return {"cols": cols, "rows": rows}


# -------------------------------------------------------------- NST sources

TEAMGAME_STATS = ["TOI", "CF", "CA", "FF", "FA", "SF", "SA", "GF", "GA",
                  "xGF", "xGA", "SCF", "SCA", "HDCF", "HDCA"]


def nst_team_games(season):
    """Every team's per-game totals: all situations, 5v5, power play, penalty kill."""
    out = {"cols": ["date", "team", "sit"] + TEAMGAME_STATS, "rows": []}
    unknown = set()
    for sit in ("all", "5v5", "pp", "pk"):
        html = nst("games.php", {
            "fromseason": season, "thruseason": season, "stype": 2, "sit": sit,
            "loc": "B", "team": "All", "team2": "All", "rate": "n"})
        head, body = find_table(html, ["Game", "Team", "GF", "GA", "xGF", "xGA"])
        ix = {n: head.index(n) for n in head}
        if "TOI" not in ix:
            # NST sometimes labels it differently ("TOI (min)", "Time on Ice").
            alt = next((n for n in head if re.match(r"(toi|time on ice)", n, re.I)), None)
            if alt:
                ix["TOI"] = ix[alt]
            elif sit == "all":
                note(f"{label(season)} team games: no TOI column; headers are: {' | '.join(head)}", "warning")
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


# ------------------------------------------------- AHL / ECHL (HockeyTech)

# Public keys the league websites themselves use to read their stats.
HOCKEYTECH = {
    "AHL": {"key": "50c2cd9b5e18e390", "client": "ahl"},
    "ECHL": {"key": "2c2b89ea7345cae8", "client": "echl"},
}
HT = "https://lscluster.hockeytech.com/feed/index.php"


def ht(league, params):
    cfg = HOCKEYTECH[league]
    q = dict(params, key=cfg["key"], client_code=cfg["client"], fmt="json", lang="en")
    text = fetch(HT + "?" + urllib.parse.urlencode(q), timeout=60).strip()
    if text.startswith("(") and text.endswith(")"):
        text = text[1:-1]  # some feeds wrap the JSON in parentheses
    return json.loads(text)


def ht_season_id(league, season):
    seasons = ht(league, {"feed": "modulekit", "view": "seasons"})["SiteKit"]["Seasons"]
    want = f"{label(season)} Regular Season"
    match = next((x for x in seasons if x.get("season_name") == want), None)
    if not match:
        raise RuntimeError(f"{league}: no season named {want}")
    return match["season_id"]


def ht_rows(payload):
    """statviewfeed tables: [ {sections: [ {data: [ {row: {...}} ]} ]} ]"""
    first = payload[0] if isinstance(payload, list) else payload
    out = []
    for sec in first.get("sections", []):
        for d in sec.get("data", []):
            row = d.get("row") or {}
            if row.get("player_id"):
                out.append((row, d.get("prop") or {}))
    return out


def mins(v):
    return num(v)


MINOR_GOALIE_COLS = ["league", "id", "name", "team", "gp", "toi", "sa", "sv", "ga", "w", "l", "otl", "so"]
MINOR_GAME_COLS = ["league", "id", "date", "game", "team", "toi", "sa", "sv", "ga", "dec", "so", "gameId"]


def minor_goalies(season):
    """Every AHL and ECHL goalie this season, with game logs."""
    goalies, games, teams, seasons = [], [], {}, {}
    for league in HOCKEYTECH:
        sid = ht_season_id(league, season)
        seasons[league] = sid
        tl = ht(league, {"feed": "modulekit", "view": "teamsbyseason", "season_id": sid})
        teams[league] = [{"id": t["id"], "name": t["name"], "code": t.get("code", "")}
                         for t in tl["SiteKit"]["Teamsbyseason"]]
        rows = ht_rows(ht(league, {"feed": "statviewfeed", "view": "players", "season": sid,
                                   "team": "all", "position": "goalies", "statsType": "standard",
                                   "limit": 1000, "first": 0, "sort": "gaa", "qualified": "all",
                                   "rookies": 0, "division": -1}))
        for row, _ in rows:
            gp = int(num(row.get("games_played")) or 0)
            if gp <= 0:
                continue
            pid = row["player_id"]
            goalies.append([league, pid, row.get("name"), row.get("team_code"), gp,
                            rnd(mins(row.get("minutes_played")), 1), int(num(row.get("shots")) or 0),
                            int(num(row.get("saves")) or 0), int(num(row.get("goals_against")) or 0),
                            int(num(row.get("wins")) or 0), int(num(row.get("losses")) or 0),
                            int(num(row.get("ot_losses")) or 0), int(num(row.get("shutouts")) or 0)])
            try:
                log = ht(league, {"feed": "statviewfeed", "view": "player", "player_id": pid,
                                  "season_id": sid, "site_id": 0, "statsType": "standard"})
            except Exception as e:  # noqa: BLE001
                note(f"{league} game log for {row.get('name')}: {e}", "warning")
                continue
            for sec in (log.get("gameByGame") or [{}])[0].get("sections", []):
                for d in sec.get("data", []):
                    g, prop = d.get("row") or {}, d.get("prop") or {}
                    if not g.get("date_played"):
                        continue
                    link = ((prop.get("game") or {}).get("gameLink")) or ""
                    dec = "W" if str(g.get("win")) == "1" else "OTL" if str(g.get("ot_loss")) == "1" else "L" if str(g.get("loss")) == "1" else ""
                    games.append([league, pid, g["date_played"][:10], g.get("game", ""), row.get("team_code"),
                                  rnd(mins(g.get("minutes")), 1), int(num(g.get("shots_against")) or 0),
                                  int(num(g.get("saves")) or 0), int(num(g.get("goals_against")) or 0),
                                  dec, int(num(g.get("shutout")) or 0), str(link)])
            time.sleep(0.25)
    if not goalies:
        raise RuntimeError("no minor league goalies")
    note(f"minor league goalies: {len(goalies)} goalies, {len(games)} games")
    return {"seasons": seasons, "teams": teams,
            "goalies": {"cols": MINOR_GOALIE_COLS, "rows": goalies},
            "games": {"cols": MINOR_GAME_COLS, "rows": games}}


# ---------------------------------------------------------------- socials

SUBREDDITS = {
    "ANA": "AnaheimDucks", "BOS": "BostonBruins", "BUF": "sabres", "CGY": "CalgaryFlames",
    "CAR": "canes", "CHI": "hawks", "COL": "ColoradoAvalanche", "CBJ": "BlueJackets",
    "DAL": "DallasStars", "DET": "DetroitRedWings", "EDM": "EdmontonOilers",
    "FLA": "FloridaPanthers", "LAK": "losangeleskings", "MIN": "wildhockey", "MTL": "Habs",
    "NSH": "Predators", "NJD": "devils", "NYI": "NewYorkIslanders", "NYR": "rangers",
    "OTT": "OttawaSenators", "PHI": "Flyers", "PIT": "penguins", "SJS": "SanJoseSharks",
    "SEA": "SeattleKraken", "STL": "stlouisblues", "TBL": "TampaBayLightning", "TOR": "leafs",
    "UTA": "UtahHockeyClub", "VAN": "canucks", "VGK": "goldenknights", "WSH": "caps",
    "WPG": "winnipegjets",
}
ATOM = "{http://www.w3.org/2005/Atom}"


def news_for(name):
    q = urllib.parse.urlencode({"q": f'"{name}"', "hl": "en-CA", "gl": "CA", "ceid": "CA:en"})
    root = ET.fromstring(fetch("https://news.google.com/rss/search?" + q))
    out = []
    for item in root.iter("item"):
        src = item.find("source")
        out.append({"title": item.findtext("title", ""), "link": item.findtext("link", ""),
                    "source": src.text if src is not None else "",
                    "date": item.findtext("pubDate", "")})
        if len(out) >= 20:
            break
    return out


def reddit_for(sub):
    xml = fetch(f"https://www.reddit.com/r/{sub}/new/.rss?limit=20",
                headers={"User-Agent": "NHLStats/1.0 (personal stats page)"})
    root = ET.fromstring(xml)
    out = []
    for e in root.iter(ATOM + "entry"):
        link = e.find(ATOM + "link")
        out.append({"title": e.findtext(ATOM + "title", ""),
                    "link": link.get("href") if link is not None else "",
                    "author": (e.findtext(f"{ATOM}author/{ATOM}name", "") or "").replace("/u/", ""),
                    "date": e.findtext(ATOM + "updated", "")})
    return out[:20]


REDDIT_PER_RUN = 8   # Reddit limits anonymous readers; refresh a few teams per run


def socials(names):
    """Latest news headlines for every team, and Reddit posts for a rotating
    handful of teams per run (the rest carry over from the published copy)."""
    prev = {}
    if SITE_URL:
        try:
            prev = fetch_json(f"{SITE_URL}/data/socials.json").get("teams", {})
        except Exception:  # noqa: BLE001
            prev = {}
    out, news_ok = {}, 0
    for code, name in sorted(names.items()):
        old = prev.get(code, {})
        entry = {"news": old.get("news", []), "reddit": old.get("reddit", []),
                 "redditAt": old.get("redditAt", ""), "subreddit": SUBREDDITS.get(code, "")}
        try:
            entry["news"] = news_for(name)
            news_ok += 1
        except Exception:  # noqa: BLE001
            pass
        out[code] = entry
        time.sleep(0.3)

    due = sorted((c for c in out if out[c]["subreddit"]), key=lambda c: out[c]["redditAt"])[:REDDIT_PER_RUN]
    reddit_ok, reddit_err = 0, ""
    for code in due:
        try:
            out[code]["reddit"] = reddit_for(out[code]["subreddit"])
            out[code]["redditAt"] = dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
            reddit_ok += 1
        except Exception as e:  # noqa: BLE001
            reddit_err = str(e)
            if "429" in reddit_err:
                break  # rate limited: try again next run
        time.sleep(7)
    note(f"socials: news for {news_ok} teams, Reddit refreshed for {reddit_ok} of {len(due)}"
         + (f" (Reddit: {reddit_err[:120]})" if reddit_err else ""))
    return {"generated": dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z", "teams": out}


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

    files = ["standings", "schedule", "teamgames", "skaters", "leaders", "goalies", "goaliegames", "teamsummary"]
    manifest = {"generated": dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
                "mode": mode, "version": DATA_VERSION, "current": cur, "nst": bool(NST_KEY), "seasons": [], "notes": notes}

    goalie_ids = {}
    for season in seasons:
        is_cur = season == cur
        prev = prev_built.get(season)
        # Past seasons don't change: carry them over once they are complete.
        # (Complete means it has every file this builder makes, so adding a new
        # data file rebuilds older seasons once.)
        prev_complete = (bool(prev) and set(files) <= set(prev.get("files", []))
                         and (prev_manifest or {}).get("version") == DATA_VERSION)
        reuse_all = (not is_cur and prev_complete) or (mode == "light" and prev)
        have = {}
        if reuse_all:
            for name in files:
                data = load_prev(season, name)
                if data is not None:
                    save(season, name, data)
                    have[name] = True
        teams, names = [], {}

        if is_cur or not reuse_all:
            ok = step(season, "standings", lambda: nhl_standings(season, is_cur), prev, True)
            have["standings"] = ok or have.get("standings", False)
            try:
                with open(os.path.join(season_dir(season), "standings.json")) as f:
                    st = json.load(f)["teams"]
                teams = [t["team"] for t in st]
                names = {t["name"]: t["team"] for t in st}
            except Exception:  # noqa: BLE001
                teams, names = [], {}

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
            have["teamsummary"] = step(season, "teamsummary", lambda: nhl_team_summary(season, names), prev) or have.get("teamsummary")
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
            have["teamsummary"] = step(season, "teamsummary", lambda: nhl_team_summary(season, names), prev)
            have["goalies"] = step(season, "goalies", lambda: mp_goalies(season), prev)
            if have["goalies"]:
                with open(os.path.join(season_dir(season), "goalies.json")) as f:
                    goalie_ids[season] = {r[0] for r in json.load(f)["rows"]}

        manifest["seasons"].append({
            "code": season, "label": label(season), "games": SEASON_GAMES.get(season, 82),
            "current": is_cur, "files": sorted(k for k, v in have.items() if v),
        })

    # Minor league goalies: current season only (affiliations are current).
    cur_entry = next(x for x in manifest["seasons"] if x["code"] == cur)
    if mode == "full" or "minorgoalies" not in (prev_built.get(cur) or {}).get("files", []):
        ok = step(cur, "minorgoalies", lambda: minor_goalies(cur), prev_built.get(cur))
    else:
        data = load_prev(cur, "minorgoalies")
        ok = data is not None
        if ok:
            save(cur, "minorgoalies", data)
    if ok:
        cur_entry["files"] = sorted(set(cur_entry["files"]) | {"minorgoalies"})

    # News and Reddit, every run.
    try:
        with open(os.path.join(season_dir(cur), "standings.json")) as f:
            names = {t["team"]: re.sub(r"Montr.al", "Montreal", t["name"]) for t in json.load(f)["teams"]}
        with open(os.path.join(OUT, "socials.json"), "w") as f:
            json.dump(socials(names), f, separators=(",", ":"), ensure_ascii=False)
        manifest["socials"] = True
    except Exception as e:  # noqa: BLE001
        note(f"socials failed: {e}", "warning")

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
