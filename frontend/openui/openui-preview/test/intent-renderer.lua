-- Intent-board renderer logic under Lua 5.4 with a stubbed Tern API.
-- NOT Luau validation, Tern rendering, screenshots, or input-to-paint evidence.
local def, fixture = nil, nil
local function node(k, p, c) return {k = k, p = p or {}, c = c or {}} end
tern = {
    block = {define = function(id, value) assert(id == "reply"); def = value end},
    fs = {read = function() return "{}" end},
    json = {decode = function() return fixture end},
    ui = {
        text = function(text) return node("text", {text = text}) end,
        col = function(c) return node("col", nil, c) end,
        row = function(c) return node("row", nil, c) end,
        el = function(tag, p, c) return node("el:" .. tag, p, c) end,
        node = node,
    },
}
assert(loadfile(arg[1] or "tern/host.luau"))()
local H = string.rep("a", 64)
local function rows(...) local out = {}; for i, l in ipairs({...}) do out[i] = {label = l, value = 1000 * (4 - i)} end; return out end
local function setup(sections, alter)
    local doc = {version = 1, title = "Intent board",
        intent = {revision = 3, sourceHash = "d79b95ab528b", sentences = {{text = "keep Working while work runs", role = "task"}, {text = "ui is misleading", role = "context"}}},
        contract = {approval = "pending", contractHash = "f072a99a0b6c", preconditions = {{label = "fleet-build", state = "pass"}, {label = "#130898", state = "unknown"}},
            acceptance = {receipt = "missing", clauses = {".working_while_running == true"}}, facts = {{text = "observed fact", label = "observed"}}},
        work = {slices = {{id = "H1", title = "port reports", where = "fork/hermes-agent", state = "built"}, {id = "P1", title = "real-turn proof", where = "after H1", state = "blocked"}}},
        intel = {decisions = {rows = 28157, last = "2026-10-28T21:47Z", execution = rows("orchestration", "live"), providers = rows("groq / gpt-oss"), status = rows("started", "completed")},
            value = {estimatedAvoided = 107971, pairedRows = 224, reportedSaved = 87471, verifiedTasks = 0},
            context = {episodes = 4440, imported = 96, predictions = 30303, judged = 8149, hit = 1227, top1 = rows("stay", "switch_app")},
            health = {ok = false, backends = {{id = "nanojev", ready = true, ["local"] = true}, {id = "laya_421m", ready = false, ["local"] = true}}}},
    }
    if alter then alter(doc) end
    fixture = {schema = "hermes-openui-preview/v1", id = H,
        selection = {schema = "native-visual-selection/v1", status = "validated-not-verified",
            snapshot = {key = "z0", id = string.rep("b", 64), rendererHash = string.rep("c", 64)}, view = {kind = "intent-board", sections = sections}},
        artifact = {id = string.rep("b", 64), rendererHash = string.rep("c", 64), document = doc}}
    return def.init({}, {"/fixture.hvisual.json"}, nil)
end
local function eq(a, b) assert(a == b, tostring(a) .. " ~= " .. tostring(b)) end
local function find(n, pred)
    if pred(n) then return n end
    for _, child in ipairs(n.c or {}) do local hit = find(child, pred); if hit then return hit end end
end
local function texts(n, out)
    out = out or {}
    if n.p and n.p.text then table.insert(out, n.p.text) end
    for _, child in ipairs(n.c or {}) do texts(child, out) end
    return out
end
local count = 0
local function test(name, fn) fn(); count = count + 1; print("ok " .. count .. " - " .. name) end
local ALL = {{kind = "DeclaredIntent"}, {kind = "ContractGates"}, {kind = "WorkSlices"}, {kind = "ProofReceipts"},
    {kind = "DecisionMix", by = "execution"}, {kind = "TokenValue"}, {kind = "ContextFlow"}, {kind = "RuntimeHealth"}}

test("renders the selected sections in selection order, one card each", function()
    local frame = def.view(setup({{kind = "WorkSlices"}, {kind = "DeclaredIntent"}}), {})
    eq(#frame.main.c, 3)
    eq(frame.main.c[2].p.role, "hermes.openui.section.WorkSlices")
    eq(frame.main.c[3].p.role, "hermes.openui.section.DeclaredIntent")
    assert(string.find(frame.main.c[2].p.class, "ni-selected", 1, true))
end)
test("all eight sections render host values, not model values", function()
    local all = table.concat(texts(def.view(setup(ALL), {}).main), "\n")
    for _, want in ipairs({"keep Working while work runs", "pending", "1/2", "H1", "28,157", "107,971", "15.1%", "nanojev · local", "source d79b95ab528b"}) do
        assert(string.find(all, want, 1, true), "missing " .. want)
    end
end)
test("DecisionMix charts the selected dimension only", function()
    local chart = find(def.view(setup({{kind = "DecisionMix", by = "status"}}), {}).main, function(n) return n.k == "chart" end)
    eq(chart.p.series[1].label, "started"); eq(#chart.p.series, 2); eq(chart.p.summary, "Outcomes")
end)
test("up/down and click move the selected section; bounds hold", function()
    local s = setup(ALL)
    eq(def.key(s, {name = "up"}, {}), false)
    eq(def.key(s, {name = "down"}, {}), true); eq(s.selected, 2)
    def.event(s, {ev = "action", act = "select", value = "8"}, {}); eq(s.selected, 8)
    eq(def.key(s, {name = "down"}, {}), false)
    def.event(s, {ev = "action", act = "select", value = "2.5"}, {}); eq(s.selected, 8)
    assert(string.find(def.view(s, {}).dock.c[2].p.text, "RuntimeHealth (8/8)", 1, true))
end)
test("repository keys do nothing on an intent board", function()
    local s = setup(ALL)
    eq(def.key(s, {name = "1"}, {}), false); eq(def.key(s, {name = "enter"}, {}), false)
end)
for _, case in ipairs({
    {"an invented section", {{kind = "ApproveContract"}}},
    {"a duplicate section", {{kind = "TokenValue"}, {kind = "TokenValue"}}},
    {"an unknown dimension", {{kind = "DecisionMix", by = "tokens"}}},
    {"no sections", {}},
}) do test("rejects " .. case[1], function() assert(not pcall(setup, case[2])) end) end
for _, case in ipairs({
    {"approval outside the enum", function(d) d.contract.approval = "auto" end},
    {"a fractional count", function(d) d.intel.value.verifiedTasks = 0.5 end},
    {"hits above judged", function(d) d.intel.context.hit = 9000 end},
    {"a control character", function(d) d.intel.decisions.execution[1].label = "x\27[2J" end},
}) do test("rejects a document with " .. case[1], function() assert(not pcall(setup, ALL, case[2])) end) end
print(count .. " intent renderer-logic checks passed (Lua 5.4 + stub Tern; not live Luau/Tern)")
