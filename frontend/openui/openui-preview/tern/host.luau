-- Fixed host code: adapted from kvnloo/oh-my-pi's native-visual experiment.
-- Credits/provenance in README. No generated code, timers, network or process calls.
local ui = tern.ui
local LIMIT, MAX_VALUE = 128, 1000000000000
local function validHash(s)
    return type(s) == "string" and #s == 64 and not string.find(s, "[^a-f0-9]")
end
local function rank(a, b, mode)
    if a[mode] == b[mode] then return a.id < b.id end
    return a[mode] > b[mode]
end
local function load(path)
    -- Only open host-prepared files; fs.read itself has no pre-read byte bound.
    local raw = tern.fs.read(path)
    assert(#raw <= 8388608, "Preview exceeds 8 MiB")
    local bundle = tern.json.decode(raw)
    assert(bundle.schema == "hermes-openui-preview/v1" and validHash(bundle.id), "Invalid preview")
    local s, doc = bundle.selection, bundle.artifact.document
    assert(s.status == "validated-not-verified" and s.schema == "native-visual-selection/v1", "Not a validated selection")
    assert(s.snapshot.id == bundle.artifact.id and s.snapshot.rendererHash == bundle.artifact.rendererHash, "Mismatched snapshot")
    assert(doc.version == 1 and type(doc.title) == "string" and #doc.title <= 640, "Invalid document")
    if s.view.kind == "intent-board" then return bundle end
    assert(s.view.kind == "repo-explorer" and s.view.visibleLimit == LIMIT, "Invalid view")
    assert(s.view.mode == "code" or s.view.mode == "churn", "Invalid mode")
    assert(type(s.view.hottestLimit) == "number" and s.view.hottestLimit % 1 == 0 and s.view.hottestLimit >= 1 and s.view.hottestLimit <= 12, "Invalid hottest limit")
    local allowed, used = {files = true, code = true, churn = true}, {}
    assert(type(s.view.metrics) == "table" and #s.view.metrics >= 1 and #s.view.metrics <= 3, "Invalid metrics")
    for _, metric in ipairs(s.view.metrics) do
        assert(allowed[metric] and not used[metric], "Invalid metric")
        used[metric] = true
    end
    local seen, count, files, hottest = {}, 0, {}, {}
    local function visit(node, depth, root)
        count = count + 1
        assert(depth <= 16 and count <= 60000, "Tree exceeds bounds")
        assert(type(node.id) == "string" and #node.id <= 64 and string.match(node.id, "^[a-zA-Z][a-zA-Z0-9_-]*$") and not seen[node.id], "Invalid node")
        seen[node.id] = true
        assert(type(node.label) == "string" and #node.label > 0 and #node.label <= 640 and not string.find(node.label, "%c"), "Invalid label")
        for _, metric in ipairs({"code", "churn"}) do
            local value = node[metric]
            assert(type(value) == "number" and value == value and value >= 0 and value <= MAX_VALUE and value % 1 == 0, "Invalid value")
        end
        assert(type(node.children) == "table", "Invalid children")
        local code, churn, n, top = 0, 0, 0, {}
        for _, child in ipairs(node.children) do
            visit(child, depth + 1, false)
            code, churn, n = code + child.code, churn + child.churn, n + files[child]
            -- Merge only twelve candidates per subtree, then bound immediately.
            for _, leaf in ipairs(hottest[child]) do table.insert(top, leaf) end
            table.sort(top, function(a, b) return rank(a, b, "churn") end)
            while #top > 12 do table.remove(top) end
        end
        assert(#node.children == 0 or (code == node.code and churn == node.churn), "Incorrect aggregate")
        if #node.children == 0 and not root then n, top = 1, {node} end
        files[node], hottest[node] = n, top
    end
    visit(doc.root, 0, true)
    return bundle, files, hottest
end
local function project(state, selectedId)
    local byMode = state.projections[state.current]
    if not byMode then byMode = {}; state.projections[state.current] = byMode end
    local items = byMode[state.mode]
    if not items then
        items = {}
        for _, child in ipairs(state.current.children) do table.insert(items, child) end
        table.sort(items, function(a, b) return rank(a, b, state.mode) end)
        if #items > LIMIT then
            local other = {id = "@other:" .. state.current.id, label = "Other (" .. (#items - LIMIT + 1) .. ")", code = 0, churn = 0, children = {}}
            local top, n = {}, 0
            for i = LIMIT, #items do
                local child = items[i]
                table.insert(other.children, child)
                other.code, other.churn, n = other.code + child.code, other.churn + child.churn, n + state.files[child]
                for _, leaf in ipairs(state.hottest[child]) do table.insert(top, leaf) end
                table.sort(top, function(a, b) return rank(a, b, "churn") end)
                while #top > 12 do table.remove(top) end
            end
            state.files[other], state.hottest[other] = n, top
            while #items >= LIMIT do table.remove(items) end
            table.insert(items, other)
        end
        byMode[state.mode] = items
    end
    state.items, state.selected, state.cached = items, 1, nil
    for index, item in ipairs(items) do if item.id == selectedId then state.selected = index end end
end
local function mode(state, value)
    if state.mode == value then return false end
    local selected = state.items[state.selected]
    state.mode = value
    project(state, selected and selected.id)
    return true
end
local function drill(state, index)
    local item = state.items[index]
    if not item then return false end
    if #item.children == 0 then
        if state.selected == index then return false end
        state.selected, state.cached = index, nil
        return true
    end
    table.insert(state.stack, {node = state.current, selected = item.id})
    state.current = item
    project(state)
    return true
end
local function back(state)
    local parent = table.remove(state.stack)
    if not parent then return false end
    state.current = parent.node
    project(state, parent.selected)
    return true
end
local function button(label, action, key)
    return ui.el("button", {text = label, key = key, class = "nv-button", role = "hermes.openui." .. key, actions = {click = action}})
end
-- Bounded slice-and-dice geometry; zero weights receive a disclosed minimum area.
local function tiles(state, first, last, depth)
    if first > last then return ui.text("No children.") end
    if first == last then
        local item = state.items[first]
        local class = "nv-cell"
        if first == state.selected then class = class .. " nv-selected" end
        return ui.el("div", {key = item.id, class = class, role = "hermes.openui.child." .. item.id,
            aria = item.label, title = string.format("%s: %d code, %d churn", item.label, item.code, item.churn),
            grow = math.max(item[state.mode], 1), basis = 0, actions = {click = "drill=" .. item.id}}, {
                ui.el("span", {class = "nv-label", text = item.label})
            })
    end
    local total, accumulated, split = 0, 0, first
    for i = first, last do total = total + math.max(state.items[i][state.mode], 1) end
    for i = first, last - 1 do
        accumulated = accumulated + math.max(state.items[i][state.mode], 1); split = i
        if accumulated >= total / 2 then break end
    end
    local left, right = tiles(state, first, split, depth + 1), tiles(state, split + 1, last, depth + 1)
    left.p = left.p or {}; right.p = right.p or {}
    left.p.grow, left.p.basis, right.p.grow, right.p.basis = accumulated, 0, total - accumulated, 0
    local class = "nv-split nv-row"
    if depth % 2 == 1 then class = "nv-split nv-col" end
    return ui.el("div", {key = "split-" .. first .. "-" .. last, class = class}, {left, right})
end
-- Intent board (ephemeral-intent/v1). Sections and order come from the validated selection;
-- every value comes from the host document. Read-only: no section approves, executes or publishes.
local SECTION = {DeclaredIntent = true, ContractGates = true, WorkSlices = true, ProofReceipts = true,
    DecisionMix = true, TokenValue = true, ContextFlow = true, RuntimeHealth = true}
local function str(v, max) return type(v) == "string" and #v > 0 and #v <= (max or 400) and not string.find(v, "%c") end
local function int(v) return type(v) == "number" and v == v and v >= 0 and v <= MAX_VALUE and v % 1 == 0 end
local function bounded(t, max) return type(t) == "table" and #t <= (max or 12) end
local function commas(n)
    local s = tostring(math.floor(n))
    local out = s:reverse():gsub("(%d%d%d)", "%1,"):reverse()
    if out:sub(1, 1) == "," then out = out:sub(2) end
    return out
end
local function checkIntent(bundle)
    local s, doc = bundle.selection, bundle.artifact.document
    assert(bounded(s.view.sections, 8) and #s.view.sections >= 1, "Invalid sections")
    local used = {}
    for _, section in ipairs(s.view.sections) do
        assert(SECTION[section.kind] and not used[section.kind], "Invalid section")
        used[section.kind] = true
        if section.kind == "DecisionMix" then
            assert(section.by == "execution" or section.by == "providers" or section.by == "status", "Invalid dimension")
        end
    end
    local c, w, i = doc.contract, doc.work, doc.intel
    assert(type(doc.intent) == "table" and int(doc.intent.revision) and str(doc.intent.sourceHash, 64) and bounded(doc.intent.sentences, 8), "Invalid intent")
    assert(type(c) == "table" and (c.approval == "pending" or c.approval == "approved" or c.approval == "rejected"), "Invalid contract")
    assert(bounded(c.preconditions) and type(c.acceptance) == "table" and bounded(c.acceptance.clauses) and bounded(c.facts), "Invalid contract")
    assert(c.acceptance.receipt == "missing" or c.acceptance.receipt == "present", "Invalid receipt")
    assert(type(w) == "table" and bounded(w.slices), "Invalid work")
    assert(type(i) == "table" and type(i.decisions) == "table" and int(i.decisions.rows), "Invalid intel")
    for _, by in ipairs({"execution", "providers", "status"}) do
        assert(bounded(i.decisions[by], 8), "Invalid rows")
        for _, row in ipairs(i.decisions[by]) do assert(str(row.label) and int(row.value), "Invalid row") end
    end
    for _, k in ipairs({"estimatedAvoided", "pairedRows", "reportedSaved", "verifiedTasks"}) do assert(int(i.value[k]), "Invalid value") end
    for _, k in ipairs({"episodes", "imported", "predictions", "judged", "hit"}) do assert(int(i.context[k]), "Invalid context") end
    assert(i.context.hit <= i.context.judged and bounded(i.context.top1, 8), "Invalid context")
    assert(type(i.health.ok) == "boolean" and bounded(i.health.backends), "Invalid health")
end
local function stat(label, value, foot)
    return ui.el("div", {class = "ni-stat"}, {ui.el("span", {class = "ni-k", text = label}),
        ui.el("b", {class = "ni-v", text = value}), ui.el("small", {class = "ni-f", text = foot})})
end
local function chip(text, tone) return ui.el("span", {class = "ni-chip ni-" .. (tone or "muted"), text = text}) end
local function line(children) return ui.el("div", {class = "ni-line"}, children) end
local function bars(rows, summary)
    local series, list = {}, {}
    for n, row in ipairs(rows) do
        series[n] = {label = row.label, value = row.value, title = row.label .. ": " .. commas(row.value)}
        -- The small chart carries shape only; labels and counts stay readable as rows.
        list[n] = line({ui.el("span", {class = "ni-grow ni-code", text = row.label}), ui.el("b", {text = commas(row.value)})})
    end
    table.insert(list, 1, ui.node("chart", {kind = "bars", series = series, size = "sm", summary = summary}))
    return ui.el("div", {class = "ni-body"}, list)
end
local GATE = {pass = {"✓", "ok"}, changed = {"changed", "warn"}, unknown = {"?", "warn"}}
local RENDER = {}
function RENDER.DeclaredIntent(doc)
    local rows = {}
    for n, s in ipairs(doc.intent.sentences) do rows[n] = line({ui.el("span", {class = "ni-quote", text = s.text}), chip(s.role == "task" and "+ task" or "context", s.role == "task" and "accent" or "muted")}) end
    table.insert(rows, ui.text("source " .. string.sub(doc.intent.sourceHash, 1, 12) .. " · r" .. doc.intent.revision .. " · exact words; edits become a new revision"))
    return "Ripple", "One ask. Exact words.", rows
end
function RENDER.ContractGates(doc)
    local c, observed = doc.contract, 0
    for _, p in ipairs(c.preconditions) do if p.state == "pass" then observed = observed + 1 end end
    local rows = {ui.el("div", {class = "ni-stats"}, {stat("Approval", c.approval, "not executable"),
        stat("Preconditions", observed .. "/" .. #c.preconditions, "observed at capture"),
        stat("Acceptance", c.acceptance.receipt == "present" and "receipt present" or "unproven", c.acceptance.receipt .. " receipt")})}
    for _, clause in ipairs(c.acceptance.clauses) do table.insert(rows, line({chip("?", "warn"), ui.el("code", {class = "ni-code", text = clause})})) end
    table.insert(rows, ui.text("contract " .. string.sub(c.contractHash, 1, 12) .. " · formal approval stays with the host"))
    return "AODL", "Review before execution", rows
end
function RENDER.WorkSlices(doc)
    local rows = {}
    for n, s in ipairs(doc.work.slices) do
        rows[n] = line({ui.el("b", {class = "ni-node", text = s.id}), ui.el("span", {class = "ni-grow", text = s.title .. " — " .. s.where}),
            chip(s.state, (s.state == "built" or s.state == "done") and "ok" or "warn")})
    end
    table.insert(rows, ui.text("Implementation states are observed, not acceptance."))
    return "AODL", "Implementation is not acceptance", rows
end
function RENDER.ProofReceipts(doc)
    local c, observed = doc.contract, 0
    for _, p in ipairs(c.preconditions) do if p.state == "pass" then observed = observed + 1 end end
    local missing = c.acceptance.receipt == "missing"
    local rows = {line({ui.el("b", {class = "ni-big", text = missing and "0" or "1"}),
        ui.el("span", {class = "ni-grow", text = missing and "real-turn acceptance receipts — the job is not done yet" or "real-turn acceptance receipt present"})})}
    for _, p in ipairs(c.preconditions) do table.insert(rows, line({chip(GATE[p.state][1], GATE[p.state][2]), ui.el("span", {text = p.label})})) end
    table.insert(rows, ui.text(observed .. "/" .. #c.preconditions .. " preconditions observed. Preconditions are snapshots, not acceptance."))
    return "AODL", "Show me the real-turn receipt", rows
end
local DIM = {execution = "Execution", providers = "Providers", status = "Outcomes"}
function RENDER.DecisionMix(doc, section)
    local d = doc.intel.decisions
    return "z0intelligence", "Where decisions went", {
        ui.el("div", {class = "ni-stats"}, {stat("Decision events", commas(d.rows), "raw valid JSON rows"), stat("Newest event", string.sub(d.last, 1, 10), "historical capture")}),
        bars(d[section.by], DIM[section.by]),
        ui.text("Counts by " .. string.lower(DIM[section.by]) .. ". Not a success-rate dashboard."),
    }
end
function RENDER.TokenValue(doc)
    local v = doc.intel.value
    return "z0intelligence", "Savings, without wishful math", {
        ui.el("div", {class = "ni-stats"}, {stat("Estimated avoided", commas(v.estimatedAvoided), "counterfactual estimate"),
            stat("Paired rows", commas(v.pairedRows), "baseline + measurement"), stat("Reported saved", commas(v.reportedSaved), "receipt summary field"),
            stat("Verified tasks", commas(v.verifiedTasks), "tokens / task: N/A")}),
        ui.text("Estimated avoidance is not a billing credit. Measured + estimated + verified stay apart."),
    }
end
function RENDER.ContextFlow(doc)
    local x = doc.intel.context
    local share = x.judged > 0 and string.format("%.1f%%", 100 * x.hit / x.judged) or "N/A"
    return "z0intelligence", "Prediction meets the next action", {
        ui.el("div", {class = "ni-stats"}, {stat("Live episodes", commas(x.episodes), "closed context episodes"), stat("Imported", commas(x.imported), "not all live episodes"),
            stat("Predictions", commas(x.predictions), "flow rows"), stat("Family top-1", share, commas(x.hit) .. " / " .. commas(x.judged) .. " labeled rows")}),
        bars(x.top1, "Top-1 next action"),
        ui.text("Top-1 is a family-label match on labeled rows, not verified downstream utility."),
    }
end
function RENDER.RuntimeHealth(doc)
    local rows = {}
    for n, b in ipairs(doc.intel.health.backends) do
        rows[n] = line({chip(b.ready and "ready" or "missing", b.ready and "ok" or "warn"), ui.el("span", {class = "ni-grow", text = b.id .. " · " .. (b["local"] and "local" or "remote")})})
    end
    table.insert(rows, ui.text(doc.intel.health.ok and "Capture environment ready." or "Degraded: readiness reflects the interpreter used for this snapshot."))
    return "z0intelligence", "Can this runtime actually execute?", rows
end
local function intentView(state)
    if state.cached then return state.cached end
    local doc = state.bundle.artifact.document
    local cards = {ui.text(doc.title)}
    for n, section in ipairs(state.bundle.selection.view.sections) do
        local app, verb, body = RENDER[section.kind](doc, section)
        local class = "ni-card"
        if n == state.selected then class = class .. " ni-selected" end
        table.insert(cards, ui.el("div", {key = section.kind, class = class, role = "hermes.openui.section." .. section.kind,
            aria = app .. ": " .. verb, actions = {click = "select=" .. n}}, {
                ui.el("div", {class = "ni-head"}, {ui.el("b", {text = app}), ui.el("span", {class = "ni-verb", text = verb})}),
                ui.el("div", {class = "ni-body"}, body),
            }))
    end
    local current = state.bundle.selection.view.sections[state.selected]
    state.cached = {main = ui.col(cards), dock = ui.col({
        ui.text("Preview: " .. state.bundle.id),
        ui.text("Snapshot: " .. state.bundle.selection.snapshot.key .. " | Section: " .. current.kind .. " (" .. state.selected .. "/" .. #state.bundle.selection.view.sections .. ")"),
        ui.text("Not published · read-only · ↑/↓ section"),
    })}
    return state.cached
end
local function selectSection(state, index)
    local n = #state.bundle.selection.view.sections
    index = math.max(1, math.min(n, index))
    if index == state.selected then return false end
    state.selected, state.cached = index, nil
    return true
end
tern.block.define("reply", {
    init = function(_cx, args, _saved)
        -- Restart needs a new host capture; saved UI state never conveys approval.
        assert(type(args[1]) == "string" and string.match(args[1], "%.hvisual%.json$"), "Open a host-prepared .hvisual.json")
        local bundle, files, hottest = load(args[1])
        if bundle.selection.view.kind == "intent-board" then
            checkIntent(bundle)
            return {intent = true, bundle = bundle, selected = 1, cached = nil}
        end
        local state = {bundle = bundle, files = files, hottest = hottest, current = bundle.artifact.document.root,
            stack = {}, mode = bundle.selection.view.mode, selected = 1, items = {}, projections = {}, cached = nil}
        project(state)
        return state
    end,
    title = function(state)
        if state.intent then return "Intent: " .. state.bundle.artifact.document.title end
        return "Preview: " .. state.bundle.artifact.document.title
    end,
    view = function(state, _cx)
        if state.intent then return intentView(state) end
        if state.cached then return state.cached end
        local metrics = {}
        for _, metric in ipairs(state.bundle.selection.view.metrics) do
            local value = state.current[metric]
            if metric == "files" then value = state.files[state.current] end
            table.insert(metrics, metric .. ": " .. tostring(value))
        end
        local top = {}
        for i = 1, math.min(state.bundle.selection.view.hottestLimit, #state.hottest[state.current]) do
            local item = state.hottest[state.current][i]
            top[i] = {label = item.label, value = item.churn, title = item.label .. ": " .. item.churn .. " churn"}
        end
        local map = tiles(state, 1, #state.items, 0)
        map.p = map.p or {}; map.p.grow = 0; map.p.class = (map.p.class or "") .. " nv-map"
        local selected = state.items[state.selected]
        state.cached = {main = ui.col({
            ui.text(state.bundle.artifact.document.title .. " — " .. state.current.label),
            ui.text(table.concat(metrics, " | ")),
            ui.row({button("Code [1]", "mode=code", "code"), button("Churn [2]", "mode=churn", "churn"), button("Back [←]", "back", "back")}),
            map, ui.text("Hottest descendant files by churn; zero-weight tiles have a minimum area."),
            ui.node("chart", {kind = "bars", series = top, size = "sm", summary = "Churn"}),
        }), dock = ui.col({
            ui.text("Preview: " .. state.bundle.id),
            ui.text("Location: " .. state.current.id .. " | Mode: " .. state.mode .. " | Selection: " .. (selected and selected.id or "none")),
            ui.text("Not published · ↑/↓ select · Enter drill · ← back · 1/2 mode"),
        })}
        return state.cached
    end,
    key = function(state, key, _cx)
        if key.ctrl or key.alt or key.meta then return false end
        if state.intent then
            if key.name == "down" then return selectSection(state, state.selected + 1) end
            if key.name == "up" then return selectSection(state, state.selected - 1) end
            return false
        end
        if key.name == "1" then return mode(state, "code") end
        if key.name == "2" then return mode(state, "churn") end
        if key.name == "left" or key.name == "backspace" then return back(state) end
        if key.name == "enter" then return drill(state, state.selected) end
        if key.name == "down" or key.name == "up" then
            local delta = 1
            if key.name == "up" then delta = -1 end
            local selected = math.max(1, math.min(#state.items, state.selected + delta))
            if selected == state.selected then return false end
            state.selected, state.cached = selected, nil
            return true
        end
        return false
    end,
    event = function(state, ev, _cx)
        if ev.ev ~= "action" then return end
        if state.intent then
            local index = tonumber(ev.value)
            if ev.act == "select" and index and index % 1 == 0 then selectSection(state, index) end
            return
        end
        if ev.act == "mode" and (ev.value == "code" or ev.value == "churn") then mode(state, ev.value)
        elseif ev.act == "back" then back(state)
        elseif ev.act == "drill" then
            for i, item in ipairs(state.items) do if item.id == ev.value then drill(state, i); break end end
        end
    end,
})
