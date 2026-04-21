# drip

**Learn something while your AI thinks.**

A terminal companion for the 5-10 minutes you spend waiting on Claude Code, Cursor, or any long-running agent. Type a topic, pick a level, and drip shows you one-sentence insight cards — one at a time, one on screen. A new drip replaces the last every 30 seconds. Glance over when your brain has a second.

One file. Zero runtime deps. Node 18+. MIT.

---

## Run

```bash
npx drip-term                               # interactive onboarding
npx drip-term "diffusion models"            # topic given, picks level interactively
npx drip-term "rust borrow checker" -l advanced
npx drip-term "Thinking, Fast and Slow"     # a book title works as a topic
```

Or install it:

```bash
npm i -g drip-term
drip "distributed consensus"
```

---

## Controls (three keys)

**Drips auto-play every 10 seconds.** You don't have to press anything.

| Key                       | Action                                       |
| ------------------------- | -------------------------------------------- |
| <kbd>space</kbd>          | skip ahead — don't wait for the 10s tick     |
| <kbd>p</kbd>              | pause / resume auto-play                     |
| <kbd>q</kbd>              | back to the topic picker                     |
| <kbd>ctrl+c</kbd>         | exit drip                                    |

One card at a time, one good rhythm. No feed, no scroll, no settings.

---

## Auth — bring your own, auto-detected

drip uses your own Claude auth and never sees your key or your prompts. Two paths, auto-detected at startup:

### Path 1 — `claude` CLI (free with Pro/Max)

If you already have Claude Code signed in, drip just works.

```bash
# if you don't:
npm i -g @anthropic-ai/claude-code
claude                                   # follow the login prompts
drip                                     # auto-detects the signed-in CLI
```

No per-drip cost. drip shells out to `claude -p` under the hood.

### Path 2 — Anthropic API key (pay-per-drip)

```bash
# get a key at https://console.anthropic.com/settings/keys
export ANTHROPIC_API_KEY=sk-ant-...
drip
```

Costs about **$0.003 per drip** on Sonnet (~$0.45 for 150 drips — a full hour of auto-play). You pay Anthropic directly. drip never proxies or stores it.

### No backend, no accounts

No signup, no waitlist, no telemetry. drip is a pure client-side wrapper. The package has zero runtime dependencies. If this repo disappeared tomorrow, your existing install would still run.

---

## How the drip is shaped

One sentence. Max 25 words. No title, no bullets. Concrete — numbers, names, mechanisms. Stands alone.

> A transformer layer is just matrix multiplication plus a nonlinearity, stacked 50+ times with trillions of tuned parameters — that's the whole trick.

> Sloths climb down from trees once a week just to poop — and roughly half of all wild sloth deaths happen during that weekly descent.

> Kahneman's thesis: System 1 runs constantly and cheap, while System 2's slow deliberate thinking only engages when System 1 flags something weird.

---

## Difficulty levels

- **beginner** — plain language, zero background assumed. Vivid, surprising.
- **intermediate** — mechanisms, specific numbers, named concepts. Past the Wikipedia lead.
- **advanced** — senior-practitioner depth. Named effects, researchers, edge cases.

Depth also progresses *within* a session — drip #1 is foundational, drip #50 is nuanced.

---

## Generation (the part that matters)

- **One drip = one streaming API call.** First token arrives in ~400ms on Sonnet; full drip in 1-2s. You watch it paint live.
- **Lookahead generation.** While you read the current drip, the next one is already being generated in the background. Pressing `space` is always instant after the first card.
- **Prompt caching.** The system prompt is reused across every drip — after the first call, subsequent ones get 90% off on the cached portion.
- **Idle pause.** No input for 90 seconds and drip stops generating. Resumes on the next keypress. Your API budget doesn't burn while you're tabbed out.
- **No repeats.** A rolling list of already-shown drips goes back to the model so it never restates itself.

---

## Model

Sonnet by default — best quality-per-token for short insight cards. Override:

```bash
DRIP_MODEL=haiku drip "GPU architecture"      # cheaper, faster, slightly shallower
DRIP_MODEL=opus  drip "category theory"       # slower, denser
```

---

## What drip is — and isn't

A weekend hack for developers waiting on AI. MIT, zero-dep Node. No infra, no backend, no keys drip sees, no accounts, no telemetry, no waitlist. Fork it, extend it, ignore it.

Maintained: best effort. No roadmap. PRs welcome; no promises.

---

## Files

```
drip/
├── drip.js         the whole CLI
├── package.json    bin entry, Node 18+
├── README.md       this file
└── LICENSE         MIT
```
