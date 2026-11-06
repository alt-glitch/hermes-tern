-- Native architecture view logic with a stubbed Tern API, not live Luau/pixel evidence.
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
local function setup(alter)
    local doc = {
        v = 0, title = "Synthetic local architecture", provenance = "authored-example",
        nodes = {{id = "client", service = "client"}, {id = "router", service = "router"}, {id = "gpu", service = "llamacpp"}},
        edges = {{from = "client", to = "router", label = "request"}, {from = "router", to = "gpu", label = "inference"}},
    }
    if alter then alter(doc) end
    fixture = {schema = "hermes-openui-preview/v1", id = H,
        selection = {schema = "native-visual-selection/v1", status = "validated-not-verified",
            snapshot = {key = "arch", id = string.rep("b", 64), rendererHash = string.rep("c", 64)},
            view = {kind = "architecture-board"}},
        artifact = {id = string.rep("b", 64), rendererHash = string.rep("c", 64), document = doc}}
    return def.init({}, {"/fixture.hvisual.json"}, nil)
end
local function texts(n, out)
    out = out or {}
    if n.p and n.p.text then table.insert(out, n.p.text) end
    for _, child in ipairs(n.c or {}) do texts(child, out) end
    return out
end
local function contains(s, phrase) assert(string.find(s, phrase, 1, true), "missing " .. phrase) end
local state = setup()
assert(def.title(state) == "Architecture: Synthetic local architecture")
local frame = def.view(state, {})
local output = table.concat(texts(frame.main), "\n")
contains(output, "authored example")
contains(output, "client · client")
contains(output, "router · router")
contains(output, "Intent only: client → router · request — not verified integration")
contains(output, "Intent only: router → gpu · inference — not verified integration")
contains(table.concat(texts(frame.dock), "\n"), "No execution, approval or publication")
assert(def.key(state, {name = "enter"}, {}) == false)
assert(def.key(state, {name = "1"}, {}) == false)
def.event(state, {ev = "action", act = "approve", value = "1"}, {})
for _, change in ipairs({
    function(d) d.v = 1 end,
    function(d) d.provenance = "verified" end,
    function(d) d.nodes[2].service = "unknown" end,
    function(d) d.nodes[2].id = "client" end,
    function(d) d.nodes[2].id = "../router" end,
    function(d) d.edges[1].to = "absent" end,
    function(d) d.edges[1].to = "client" end,
    function(d) d.edges[1].label = "bad\27[2J" end,
    function(d) d.edges[1].verified = true end,
    function(d) d.nodes = {} end,
}) do assert(not pcall(setup, change)) end
print("architecture renderer-logic checks passed (Lua 5.4 + stub Tern; not live Tern)")
