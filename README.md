

---

## Prerequisites

```bash
# 1. Claude Code CLI
curl -fsSL https://claude.ai/install.sh | bash
claude   # authenticate once

# 2. Bun
curl -fsSL https://bun.sh/install | bash

# macOS: brew install tmux
# Ubuntu: sudo apt install tmux

# 4. jq
# macOS: brew install jq
# Ubuntu: sudo apt install jq
```

---


```bash
./install.sh
```

---

## Phase 2: Set up the project

```bash
mkdir eigenpal-docx-editor && cd eigenpal-docx-editor
git init


# Copy these files from the download:
#   prd.json          → project root          — full story details + acceptance criteria


# Initial commit
git add -A
```

---

## Phase 3: Run

```bash

```

---

## How it works


2. Reads `prd.json` for that task's full description and acceptance criteria
3. Investigates `the OOXML spec` source for the editor API details (not guessing)
4. Implements the task, runs `bun build` to verify


---

## File layout

```
eigenpal-docx-editor/
├── prd.json                  ← 6 user stories with full descriptions + acceptance criteria
│   ├── PROMPT.md             ← prompt fed to Claude each loop iteration
└── src/                      ← source code (built by Claude across iterations)
```

---

## After completion

```bash
bun dev   # run the dev server
```

The app will have:

- A DOCX file loader (input + drag-and-drop)
- A template variable panel (define `{name}` → `value` pairs)
- A the editor WYSIWYG viewer — fonts, styles, colors, tables, headers all preserved
- Live re-render after template substitution, with full formatting fidelity surviving the round-trip
