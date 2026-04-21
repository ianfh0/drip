# drip

**Learn something while your AI thinks.**

A terminal companion for the 5–10 minutes you spend waiting on Claude Code, Cursor, or any long-running agent. Type a topic, pick a level, and drip shows you one-sentence insight cards — one at a time, one on screen. A new drip replaces the last every 10 seconds. Glance over when your brain has a second.

One file. Zero runtime deps. Node 18+. MIT.

---

## Run

Install and run directly from GitHub — no npm registry needed:

```bash
npx github:ianfh0/drip                                    # interactive onboarding
npx github:ianfh0/drip "diffusion models"                 # topic given, picks level
npx github:ianfh0/drip "rust borrow checker" -l advanced  # fully specified
npx github:ianfh0/drip "Thinking, Fast and Slow"          # a book title works as a topic
```

Or clone it:

```bash
git clone https://github.com/ianfh0/drip.git
cd drip
./drip.js
```

The first time you run drip, it walks you through Claude auth in 30 seconds (see below). After that, it just starts.

---

## Controls

**Drips auto-play every 10 seconds.** You don't have to press anything.

| Key                       | Action                                       |
| ------------------------- | -------------------------------------------- |
| <kbd>space</kbd>          | skip ahead — don't wait for the 10s tick     |
| <kbd>p</kbd>              | pause / resume auto-play                     |
| <kbd>q</kbd>              | back to the topic picker                     |
| <kbd>ctrl+c</kbd>         | exit drip                                    |

One card at a time, one good rhythm. No feed, no scroll, no settings.

---

## Auth — guided on first run

First time you run drip, it asks one question and walks you through setup. No commands to memorize. Two paths:

### Claude Pro or Max — free, no per-drip cost

drip installs `@anthropic-ai/claude-code` for you, probes whether you're already signed in (common — just continues), and otherwise launches Claude Code once for you to sign in via browser. Then drip starts automatically.

### Anthropic API key — pay-per-drip (~$0.003 each)

drip opens the API key page in your browser. You paste the key at the prompt, drip offers to save it to your shell rc (`~/.zshrc` / `~/.bashrc` / fish config) so it persists, and drip starts automatically.

**drip never sees or stores your key.** Everything is client-side. No backend, no proxy, no accounts, no telemetry. The package has zero runtime dependencies — if this repo disappeared tomorrow, your existing install would keep running.

Cost reality for the API key path: Sonnet with prompt caching lands around **$0.003 per drip**. A full hour of 10-second auto-play (360 drips) is about $1.

---

## The drip format

One sentence. 8–10 words. No title, no bullets. Concrete — a number, a name, a mechanism, or a surprise. Stands alone.

> GPT is matrix multiplication plus a nonlinearity, stacked 50 times.

> Models generalize thousands of steps after overfitting — nobody knows why.

> Wild sloths mostly die descending trees to poop each week.

> System 2 only engages when System 1 flags something weird.

Reading time for a fast reader: about 2 seconds. Tuned to be absorbed at a glance, not to demand your attention.

---

## Difficulty levels

- **beginner** — plain English, zero jargon. Vivid mental models, not definitions. Written for a curious friend who's heard of the topic but never studied it.
- **intermediate** — assume basics are known. Named concepts, specific numbers, mechanisms, trade-offs. Written for a practitioner warming up.
- **advanced** — senior-practitioner depth. Named effects, specific researchers, recent developments, surprising edge cases. Written for someone who wants the interesting stuff.

Depth also progresses *within* a session — drip #1 is foundational, drip #50 reaches the frontier. Each drip stands alone, but they flow like a smart friend's walk-through of the topic.

---

## Under the hood

- **Instant advance.** A lookahead buffer pre-generates the next drip in the background the moment the current one lands. When the 10-second tick fires (or you press <kbd>space</kbd>), the next drip is already sitting there — no loading, no spinner.
- **Streaming.** The very first drip of a session streams in live, typewriter-style. Everything after that is pre-generated and displays instantly.
- **Prompt caching.** The system prompt is identical across every drip, so Anthropic caches it — 90% off on the cached portion after the first call.
- **Idle pause.** No input for 90 seconds and drip stops generating. Resumes on the next keypress. Your API budget doesn't burn while you're tabbed out.
- **No repeats.** A rolling list of already-shown drips goes back to the model, so it doesn't restate itself.

---

## Model

Sonnet by default — best quality-per-token for short insight cards. Override:

```bash
DRIP_MODEL=haiku drip "GPU architecture"      # cheaper, faster, slightly shallower
DRIP_MODEL=opus  drip "category theory"       # slower, denser
```

---

## What drip is — and isn't

A weekend hack for anyone waiting on AI. MIT, zero-dep Node. No infra, no backend, no keys drip sees, no accounts, no telemetry, no waitlist. Fork it, extend it, ignore it.

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
