---
name: tern-rendering
description: What Tern draws in a hermes tern reply (mermaid, svg, math, 3D, media, links) and the rules each needs to render.
---

# Rendering in Tern

In `hermes tern` your reply is drawn by Tern's own Markdown view, not printed to a terminal. It
draws GitHub-flavored Markdown plus the figures below. Use a figure when it says more than prose
would; a two-line answer needs none. Never announce or describe a figure ("Here is a diagram…");
write the text the figure does not already say.

## Pick the figure

| You want to show | Write |
| --- | --- |
| A flow, a sequence of calls, states, an architecture, dependencies, a timeline, a schema | a ```` ```mermaid ```` diagram |
| A layout, a UI mockup, geometry, a custom chart, an infographic, anything mermaid cannot lay out | an ```` ```svg ```` figure |
| A formula | TeX between `$…$` (inline) or `$$…$$` (display) |
| A 3D shape you can write as text | ```` ```stl ````, ```` ```obj ````, ```` ```ply ```` or ```` ```wrl ```` |
| A file on disk: image, PDF, video, audio, 3D model | `MEDIA:/absolute/path` alone on a line |
| Numbers to compare | a GFM table |
| A whole web page or site | write the `.html` file, then `tern open --split right /absolute/page.html` |

## Mermaid

Tern draws mermaid with merman (Mermaid 12.1). These kinds draw. Write the header as shown: some
kinds refuse a missing `-beta` (`radar-beta`, `treeView-beta`, `venn-beta`, `swimlane-beta`,
`wardley-beta`, `cynefin-beta`, `agentflow-beta`, `usecase-beta`) and some refuse an added one
(`kanban`, `eventmodeling`).

| Kind | Header | Use it for |
| --- | --- | --- |
| Flowchart | `flowchart` | processes, pipelines, architecture as boxes and arrows (with `subgraph` groups) |
| Sequence | `sequenceDiagram` | calls and messages between parts over time |
| Class | `classDiagram` | types, fields and inheritance |
| State | `stateDiagram-v2` | states and transitions |
| Entity–relationship | `erDiagram` | database tables and their relations |
| Gantt | `gantt` | schedules and plans |
| Git graph | `gitGraph` | branches, merges, release flow |
| User journey | `journey` | steps of a user's task with a score each |
| Timeline | `timeline` | events by date |
| Mindmap | `mindmap` | a topic broken into ideas |
| Kanban | `kanban` | work by column (header `kanban`, no `-beta`) |
| Quadrant chart | `quadrantChart` | items placed on two axes |
| XY chart | `xychart` | bar and line charts of numbers |
| Sankey | `sankey-beta` | flows and how they split (CSV rows: source,target,value) |
| Packet | `packet` | bit layouts of headers and records |
| Radar | `radar-beta` | several scores on shared axes |
| Block | `block-beta` | layouts of parts in columns |
| C4 | `C4Context` | systems, people and containers (`C4Context`, case-sensitive) |
| Requirement | `requirementDiagram` | requirements and what satisfies them |
| Treemap | `treemap-beta` | sizes of nested parts (labels quoted) |
| Tree view | `treeView-beta` | a file or object tree (labels quoted); labels are faint in dark themes |
| Ishikawa | `ishikawa-beta` | causes of a problem (fishbone) |
| Venn | `venn-beta` | overlap between sets |
| Swimlane | `swimlane-beta` | a process split by who does each step |
| Railroad | `railroad-beta` | grammars; also `railroad-ebnf-beta`, `railroad-abnf-beta`, `railroad-peg-beta` |
| Wardley map | `wardley-beta` | value chain against evolution (coordinates 0–1) |
| Cynefin | `cynefin-beta` | sorting problems into clear, complicated, complex, chaotic |
| Agent flow | `agentflow-beta` | agent and tool pipelines |
| Event modeling | `eventmodeling` | screens, commands and events (header `eventmodeling`, no `-beta`) |
| Use case | `usecase-beta` | actors and use cases; drawn crudely, so prefer a flowchart |
| ZenUML | `zenuml` | sequence diagrams as code; drawn on a white card |
| Pie | `pie` | shares of a whole; slices are hard to tell apart in dark themes, so prefer an xychart bar or a table |

**Not `architecture-beta`.** merman parses it, but Tern does not draw it: the figure shows the
source. Use a flowchart with `subgraph` groups, or `C4Context`, instead. The figure check flags it.

Rules that keep a diagram rendering:

- Quote any label with spaces, punctuation or keywords: `A["Parse (step 1)"]`, `B{"Ok?"}`.
- Edge labels: `A -->|"yes, cached"| B`.
- In `sequenceDiagram`, name a participant that looks like a keyword through an alias:
  `participant E as End User`.
- `<br/>` is the only HTML a label should hold.
- A `#` in a sequence message or `alt` label starts an entity, and the text after it is lost:
  write `PR 123`, not `PR #123`.
- Keep one diagram to one idea. Two small diagrams read better than one tangle.

After your reply, every diagram is checked with merman. If one does not parse you get its error and
line; answer with only the fixed diagram in its fence.

```mermaid
flowchart LR
  U["User prompt"] --> G["Gateway"]
  G --> A{"Agent loop"}
  A -->|"tool call"| T["Tools"]
  T --> A
  A -->|"final reply"| V["Tern pane"]
```

### A working example of each kind

**Sequence**

```mermaid
sequenceDiagram
  participant A
  participant B
  A->>B: Hello
  B-->>A: World
```

**Class**

```mermaid
classDiagram
  class Animal {
    +String name
    +eat()
  }
  class Dog {
    +bark()
  }
  Animal <|-- Dog
```

**State**

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Active: start
  Active --> Idle: stop
  Active --> [*]
```

**Entity–relationship**

```mermaid
erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains
```

**Gantt**

```mermaid
gantt
  title Release plan
  dateFormat YYYY-MM-DD
  section Build
    Design   :a1, 2026-01-01, 5d
    Code     :a2, after a1, 10d
  section Ship
    Release  :milestone, after a2, 0d
```

**Git graph**

```mermaid
gitGraph
  commit
  branch feature
  checkout feature
  commit id: "add-x"
  checkout main
  commit
  merge feature
```

**User journey**

```mermaid
journey
  title My working day
  section Go to work
    Make tea: 5: Me
    Do work: 1: Me, Cat
  section Go home
    Sit down: 5: Me
```

**Timeline**

```mermaid
timeline
  title Social media
  2002 : LinkedIn
  2004 : Facebook : Google
  2006 : Twitter
```

**Mindmap**

```mermaid
mindmap
  root((Project))
    Goals
      Speed
      Safety
    Risks
```

**Kanban**

```mermaid
kanban
  todo[Todo]
    t1[Write spec]
  doing[In progress]
    t2[Build parser]
  done[Done]
    t3[Pick name]
```

**Quadrant chart**

```mermaid
quadrantChart
  title Effort vs impact
  x-axis Low effort --> High effort
  y-axis Low impact --> High impact
  quadrant-1 Plan
  quadrant-2 Do now
  quadrant-3 Skip
  quadrant-4 Delegate
  Cache: [0.2, 0.8]
  Rewrite: [0.9, 0.6]
  Docs: [0.3, 0.3]
```

**XY chart**

```mermaid
xychart
  title "Sales"
  x-axis [jan, feb, mar, apr]
  y-axis "Revenue" 0 --> 100
  bar [30, 55, 70, 90]
  line [30, 55, 70, 90]
```

**Sankey**

```mermaid
sankey-beta
Solar,Grid,40
Wind,Grid,60
Grid,Homes,70
Grid,Industry,30
```

**Packet**

```mermaid
packet
  title UDP header
  0-15: "Source port"
  16-31: "Destination port"
  32-47: "Length"
  48-63: "Checksum"
```

**Radar**

```mermaid
radar-beta
  title Skills
  axis a["Rust"], b["Python"], c["SQL"], d["Ops"]
  curve x["Alice"]{4, 3, 5, 2}
  curve y["Bob"]{2, 5, 3, 4}
  max 5
  min 0
```

**Block**

```mermaid
block-beta
  columns 3
  a["Client"] b["API"] c[("DB")]
  a --> b
  b --> c
```

**C4**

```mermaid
C4Context
  title System context
  Person(user, "Customer", "Places orders")
  System(shop, "Shop", "Sells things")
  System_Ext(pay, "Payments", "Card processor")
  Rel(user, shop, "Uses")
  Rel(shop, pay, "Charges cards via")
```

**Requirement**

```mermaid
requirementDiagram
  requirement login_req {
    id: 1
    text: Users can log in
    risk: high
    verifymethod: test
  }
  element login_page {
    type: page
  }
  login_page - satisfies -> login_req
```

**Treemap**

```mermaid
treemap-beta
"Frontend"
    "React": 40
    "CSS": 15
"Backend"
    "API": 30
    "DB": 25
```

**Tree view**

```mermaid
treeView-beta
    "src"
        "main.rs"
        "lib"
            "parser.rs"
    "Cargo.toml"
```

**Ishikawa**

```mermaid
ishikawa-beta
    Blurry Photo
    Process
        Out of focus
        Shutter too slow
    User
        Shaky hands
    Equipment
        Dirty lens
```

**Venn**

```mermaid
venn-beta
  title "Team overlap"
  set Frontend
  set Backend
  set Design
  union Frontend,Backend["APIs"]
  union Frontend,Design["UI"]
```

**Swimlane**

```mermaid
swimlane-beta LR
  subgraph Customer
    req[Request]
    got[Receive answer]
  end
  subgraph Support
    triage[Triage]
    answer[Reply]
  end
  req --> triage --> answer --> got
```

**Railroad**

```mermaid
railroad-beta
expr = sequence(nonterminal("term"), zeroOrMore(sequence(choice(terminal("+"), terminal("-")), nonterminal("term")))) ;
term = choice(nonterminal("number"), sequence(terminal("("), nonterminal("expr"), terminal(")"))) ;
```

**Wardley map**

```mermaid
wardley-beta
title Tea Shop
anchor Business [0.95, 0.63]
component Cup of Tea [0.79, 0.61]
component Hot Water [0.52, 0.80]
component Kettle [0.43, 0.35]
component Power [0.10, 0.70]
Business -> Cup of Tea
Cup of Tea -> Hot Water
Hot Water -> Kettle
Kettle -> Power
evolve Kettle 0.62
note "Kettles commoditise" [0.30, 0.49]
```

**Cynefin**

```mermaid
cynefin-beta
  title Team practices
  clear
    "Runbook"
  complicated
    "Expert review"
  complex
    "Experiment"
  chaotic
    "Incident"
  clear --> complex : "Probe"
```

**Agent flow**

```mermaid
agentflow-beta TB
flow support["Support"]
  input["Question"]@{ shape: input }
  task["Resolve"]@{ shape: task }
  input --> task
end
```

**Event modeling**

```mermaid
eventmodeling
tf 01 ui Cart.Screen
tf 02 cmd Cart.AddItem ->> 01
tf 03 evt Cart.ItemAdded ->> 02
rf 04 rmo Cart.Summary ->> 03
```

**Use case**

```mermaid
usecase-beta
actor Customer("Customer")
actor Clerk("Clerk")
systemBoundary "Order system"
  Checkout("Place order")
  Refund("Issue refund")
end
Customer --> Checkout
Clerk --> Refund
```

**ZenUML**

```mermaid
zenuml
  Client->Server.login(user) {
    Server->DB.query()
    return token
  }
```

**Pie**

```mermaid
pie title NETFLIX
         "Time spent looking for movie" : 90
         "Time spent watching it" : 10
```

## SVG figures

An ```` ```svg ```` block shows as a picture in the theme's colors, beside the text.

- `viewBox` sets the size: 1 unit is about 1 px; keep the width at most 1000. `font-size="14"` matches body text.
- Color only with `currentColor` and `var(--fg)`, `var(--muted)`, `var(--border)`, `var(--surface)`,
  `var(--accent)`, `var(--success)`, `var(--warning)`, `var(--error)`; for data series
  `var(--c1)` … `var(--c6)`. Then it follows light and dark themes.
- Never paint a background rectangle over the whole figure.
- No `<script>`, no animation, no `<foreignObject>`, no event handlers, no external `href`.
- The root must be `<svg xmlns="http://www.w3.org/2000/svg" viewBox="…">`. It is checked after your reply.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 120" font-size="14" font-family="sans-serif">
  <rect x="10" y="30" width="120" height="50" rx="8" fill="none" stroke="var(--border)"/>
  <text x="70" y="60" text-anchor="middle" fill="currentColor">Request</text>
  <path d="M130 55 H 280" stroke="var(--accent)" stroke-width="2" marker-end="url(#a)"/>
  <rect x="290" y="30" width="120" height="50" rx="8" fill="none" stroke="var(--border)"/>
  <text x="350" y="60" text-anchor="middle" fill="currentColor">Response</text>
  <text x="205" y="45" text-anchor="middle" fill="var(--muted)" font-size="12">42 ms</text>
  <defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
    <path d="M0 0 L10 5 L0 10 z" fill="var(--accent)"/></marker></defs>
</svg>
```

## Math

`$E = mc^2$` inline; display math on its own lines:

$$
\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}
$$

`\(…\)`, `\[…\]` and a bare `\begin{aligned}…\end{aligned}` block work too. A ```` ```math ````
fence stays code. Because `$` opens math, write a literal dollar sign as `\$` ("costs \$5").
A formula that fails shows its TeX in red with the error.

## Media

A line that holds only `MEDIA:/absolute/path` shows the file there in Tern's viewer: images, SVG
files, PDFs, video (mp4, mov, webm), audio, and 3D models (obj, ply, wrl, x3d, stl, gltf, glb, fbx,
usd, 3ds). Use the absolute path; a relative one resolves against the chat's working directory.
A Markdown image `![…](…)` does not draw a picture here, local or remote.

## Links and the rest

- A file path in prose or a code span links to the file, at a line when given:
  `src/app.ts:42`, `src/a.ts#L4`, `./b.md:3:7`. Relative paths resolve against the chat's working
  directory; for anything outside it, write the absolute path or a `~/` path.
- Callouts: a quote whose first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`.
- Task lists (`- [ ]`, `- [x]`), strikethrough, autolinks.
- A table cell that is exactly `high`, `medium` or `low` shows as a severity pill.
- A hex color in a code span (`` `#4e79a7` ``) gets a swatch.
- Raw HTML shows as text. For a real page, write the file and open it beside the chat:
  `tern open --split right /absolute/page.html` (a browser block), or
  `tern browser '{"op":"open","owner":"'"$TERN_PANE"'","url":"file:///absolute/page.html"}'`
  for a picture-in-picture over the chat.
