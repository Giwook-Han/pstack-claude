# Reads and checks a pstack model sheet. Shared by check-sheet.sh, which
# setup-pstack runs after it writes a GitHub Copilot sheet, by the Copilot
# plugin hooks, which check the sheet again each time they read it, and by the
# Muse SessionStart hook. POSIX awk, run under LC_ALL=C.

# Fills roles[1..n] with the roles every sheet names, in sheet order, and
# panel[role] for the panel lists, SHEET_EFFORT[level] for the reasoning
# effort levels, SHEET_PROVIDER[provider] for the provider-seat prefixes,
# SHEET_PROVIDER_EFFORT[provider, level] for each provider's levels,
# SHEET_SEAT_ROLE[role] for the roles that take seats, and SHEET_OPTIONAL[role]
# for the roles a sheet may leave out. Returns n.
function sheet_roles(roles, panel,    n) {
  split("", roles)
  split("", panel)
  n = 0
  # Stamped from plugins/pstack/models.json; edit there and rerun tools/generate.mjs.
  roles[++n] = "feature, refactoring"
  roles[++n] = "bug-fix"
  roles[++n] = "perf-issue"
  roles[++n] = "hillclimb"
  roles[++n] = "judgment and prose"
  roles[++n] = "strongest judgment"
  roles[++n] = "how explorer"
  roles[++n] = "how explainer"
  roles[++n] = "why investigators"
  roles[++n] = "why synthesizer"
  roles[++n] = "reflect tooling"
  roles[++n] = "reflect judgment, divergent, synthesizer"
  roles[++n] = "arena runners"
  roles[++n] = "arena cross-judge pool"
  roles[++n] = "swarm workers"
  roles[++n] = "architect runners"
  roles[++n] = "interrogate reviewers"
  roles[++n] = "thermos reviewers"
  panel["arena runners"] = 1
  panel["arena cross-judge pool"] = 1
  panel["architect runners"] = 1
  panel["interrogate reviewers"] = 1
  SHEET_EFFORT["low"] = 1
  SHEET_EFFORT["medium"] = 1
  SHEET_EFFORT["high"] = 1
  SHEET_EFFORT["xhigh"] = 1
  SHEET_EFFORT["max"] = 1
  SHEET_PROVIDER["claude"] = 1
  SHEET_PROVIDER_EFFORT["claude", "low"] = 1
  SHEET_PROVIDER_EFFORT["claude", "medium"] = 1
  SHEET_PROVIDER_EFFORT["claude", "high"] = 1
  SHEET_PROVIDER_EFFORT["claude", "xhigh"] = 1
  SHEET_PROVIDER_EFFORT["claude", "max"] = 1
  SHEET_PROVIDER["codex"] = 1
  SHEET_PROVIDER_EFFORT["codex", "minimal"] = 1
  SHEET_PROVIDER_EFFORT["codex", "low"] = 1
  SHEET_PROVIDER_EFFORT["codex", "medium"] = 1
  SHEET_PROVIDER_EFFORT["codex", "high"] = 1
  SHEET_PROVIDER_EFFORT["codex", "xhigh"] = 1
  SHEET_PROVIDER_EFFORT["codex", "max"] = 1
  SHEET_PROVIDER_EFFORT["codex", "ultra"] = 1
  SHEET_PROVIDER["grok"] = 1
  SHEET_PROVIDER_EFFORT["grok", "none"] = 1
  SHEET_PROVIDER_EFFORT["grok", "minimal"] = 1
  SHEET_PROVIDER_EFFORT["grok", "low"] = 1
  SHEET_PROVIDER_EFFORT["grok", "medium"] = 1
  SHEET_PROVIDER_EFFORT["grok", "high"] = 1
  SHEET_PROVIDER_EFFORT["grok", "xhigh"] = 1
  SHEET_PROVIDER_EFFORT["grok", "max"] = 1
  SHEET_SEAT_ROLE["arena runners"] = 1
  SHEET_SEAT_ROLE["arena cross-judge pool"] = 1
  SHEET_SEAT_ROLE["architect runners"] = 1
  SHEET_SEAT_ROLE["interrogate reviewers"] = 1
  SHEET_SEAT_ROLE["thermos reviewers"] = 1
  SHEET_OPTIONAL["thermos reviewers"] = 1
  return n
}

# Adds one line decoded by read-sheet.sh to SHEET[1..SHEET_N].
function sheet_add(line) {
  SHEET[++SHEET_N] = line
}

# Quote one literal shell argument, including paths containing apostrophes.
function sheet_quote(s) {
  gsub(/'/, "'\"'\"'", s)
  return "'" s "'"
}

# Every consumer uses the same decoder. A failed read publishes no policy.
function sheet_read(file,    line, r, cmd, status) {
  SHEET_N = 0
  cmd = "sh " sheet_quote(ENVIRON["PSTACK_SHEET_READER"]) " " sheet_quote(file)
  while ((r = (cmd | getline line)) > 0) sheet_add(line)
  status = close(cmd)
  return r == 0 && status == 0
}

function sheet_trim(s) {
  sub(/^[ \t]+/, "", s)
  sub(/[ \t]+$/, "", s)
  return s
}

# The provider of a seat entry written <provider>:<model>, or "" for any other
# entry. Call sheet_roles first.
function sheet_provider(e,    p) {
  if (!match(e, /^[a-z]+:/)) return ""
  p = substr(e, 1, RLENGTH - 1)
  return (p in SHEET_PROVIDER) ? p : ""
}

# The model ID inside an entry: a seat's model after its provider prefix, or
# the entry itself.
function sheet_seat_model(e,    p) {
  p = sheet_provider(e)
  return p == "" ? e : substr(e, length(p) + 2)
}

# Drops a role value's reasoning effort suffix, as in `gpt-5.5 @xhigh` or
# `grok:grok-4.7 @xhigh`. A seat entry takes its provider's levels.
# Call sheet_roles first.
function sheet_model(e,    level, at, p) {
  if (match(e, /[ \t]+@[a-z]+$/)) {
    at = RSTART
    level = substr(e, at)
    sub(/^[ \t]+@/, "", level)
    p = sheet_provider(e)
    if (p == "" && (level in SHEET_EFFORT)) e = substr(e, 1, at - 1)
    else if (p != "" && ((p, level) in SHEET_PROVIDER_EFFORT)) e = substr(e, 1, at - 1)
  }
  return e
}

function sheet_alias(id) {
  return id == "inherit-parent" || id == "auto"
}

# An ID's vendor is the first hyphen-separated word of its model, so a seat
# and the same model without a prefix count once.
function sheet_vendor(id) {
  id = sheet_seat_model(id)
  sub(/-.*/, "", id)
  return id
}

# The key of `key: value` at the start of a line, or "" for any other line.
function sheet_key(line) {
  return line ~ /^[^ \t]/ && index(line, ":") ? sheet_trim(substr(line, 1, index(line, ":") - 1)) : ""
}

function sheet_value(line) {
  return sheet_trim(substr(line, index(line, ":") + 1))
}

# Parses SHEET. VALUE[role] is the last line's value for each known role, and
# VALUE["default effort"] the default effort. Returns what is wrong with the
# sheet as "; "-separated problems, or "" when it is well formed: a missing
# role, an entry that is not inherit-parent, auto, or a model ID with an
# optional effort, a default effort that is not session or a level, or a panel
# with models from fewer than two vendors without a `panel vendors: any` line.
# A problem quotes no unchecked sheet text, since the hook adds it to the
# session context.
# A provider seat (`<provider>:<model>`) is checked against its provider's
# levels and allowed only on a SHEET_SEAT_ROLE line, and a SHEET_OPTIONAL role
# may be missing.
# On success, SHEET_MODELS is the model set, MODEL_LIST its display list of
# explicit IDs, both without seats, and MODEL_ALIASES records whether any role
# inherits its model.
# Whatever the result, SHEET_OK[role] is 1 when that role's line has only
# usable entries, and SHEET_EFFORT_OK is 1 when a usable default effort line
# exists, for readers that keep a sheet's good lines and drop the rest.
function sheet_problems(    roles, panel, n, want, any, i, key, out, E, m, j, e, V, nv, vl, real, bad, seat) {
  n = sheet_roles(roles, panel)
  split("", want)
  for (i = 1; i <= n; i++) want[roles[i]] = 1
  split("", VALUE)
  split("", SHEET_OK)
  split("", SHEET_MODELS)
  MODEL_LIST = ""
  MODEL_ALIASES = 0
  any = 0
  for (i = 1; i <= SHEET_N; i++) {
    key = sheet_key(SHEET[i])
    if (key in want || key == "default effort") VALUE[key] = sheet_value(SHEET[i])
    else if (key == "panel vendors" && sheet_value(SHEET[i]) == "any") any = 1
  }
  out = ""
  for (i = 1; i <= n; i++) if (!(roles[i] in VALUE) && !(roles[i] in SHEET_OPTIONAL)) out = out "; missing role `" roles[i] "`"
  SHEET_EFFORT_OK = ("default effort" in VALUE) && (VALUE["default effort"] == "session" || (VALUE["default effort"] in SHEET_EFFORT))
  if (("default effort" in VALUE) && !SHEET_EFFORT_OK) out = out "; default effort is not session or a level"
  for (i = 1; i <= n; i++) {
    key = roles[i]
    if (!(key in VALUE)) continue
    m = split(VALUE[key], E, ",")
    if (m == 0) out = out "; no model in `" key "`"
    split("", V)
    nv = 0
    vl = ""
    real = 0
    bad = m == 0
    for (j = 1; j <= m; j++) {
      e = sheet_model(sheet_trim(E[j]))
      if (e == "") { out = out "; an empty entry in `" key "`"; bad = 1; continue }
      if (sheet_alias(e)) { MODEL_ALIASES = 1; SHEET_MODELS[e] = 1; continue }
      seat = sheet_provider(e) != ""
      if (seat && !(key in SHEET_SEAT_ROLE)) { out = out "; `" key "` cannot take a provider seat"; bad = 1; continue }
      if (seat && e ~ /[ \t]+@[a-z]+$/) { out = out "; `" key "` has a seat level its provider does not list"; bad = 1; continue }
      if (sheet_seat_model(e) !~ /^[a-z0-9][a-z0-9.-]*$/) { out = out "; `" key "` has an entry that is not a model ID"; bad = 1; continue }
      # A seat runs on its provider's CLI, so it is never a model for the
      # runtime's own dispatch tool and stays out of the saved model set.
      if (!seat && !(e in SHEET_MODELS)) MODEL_LIST = MODEL_LIST (MODEL_LIST == "" ? "" : ", ") "`" e "`"
      if (!seat) SHEET_MODELS[e] = 1
      real = 1
      if (!(sheet_vendor(e) in V)) {
        V[sheet_vendor(e)] = 1
        nv++
        vl = vl (vl == "" ? "" : ", ") sheet_vendor(e)
      }
    }
    SHEET_OK[key] = !bad
    if ((key in panel) && real && nv < 2 && !any) out = out "; `" key "` has models from one vendor (" vl ")"
  }
  return substr(out, 3)
}
