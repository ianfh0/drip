#!/usr/bin/env node
// drip — learn while AI thinks.
// Feed-style TUI. Each drip is a single streaming API call — tokens paint into
// the bottom of the feed as they arrive. New drip every 30s. Past drips stay
// on screen; scroll back with ↑/↓. Auto-pauses after 90s of no input.
// MIT. Zero runtime deps. Node 18+.

'use strict';

const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

// ─── paths ────────────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), '.config', 'drip');
const SEEN_FILE  = path.join(CONFIG_DIR, 'seen.jsonl');

// ─── constants ────────────────────────────────────────────────────────────────
const MAIN_MODEL = process.env.DRIP_MODEL || 'sonnet';

const CADENCE_MS         = 10_000;  // one drip every 10s — tight, ambient, fast-reader friendly
const IDLE_MS            = 90_000;  // no keypress → auto-pause
const MAX_TOKENS         = 25;      // ~10 words + punctuation — hard ceiling for glanceability
const RENDER_DEBOUNCE_MS = 30;      // min ms between partial renders

// Real, current Anthropic model IDs. Override with DRIP_MODEL env var if needed.
const MODEL_IDS = {
  haiku:  'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-5-20250929',
  opus:   'claude-opus-4-1-20250805',
};

const DIFFICULTIES = ['beginner', 'intermediate', 'advanced'];
const DIFFICULTY_TONE = {
  beginner:
    'Plain English, zero jargon. If you need a term, use an analogy instead. Audience: a curious friend who has heard of the topic but never studied it. Focus on vivid mental models, not definitions.',
  intermediate:
    'Assume basics are known. Use named concepts without defining them. Numbers, mechanisms, trade-offs. Wikipedia paragraph-3 depth — past the lead, into the guts. Audience: a practitioner warming up on the topic.',
  advanced:
    'Senior-practitioner depth. Named effects, specific researchers or papers, recent developments, surprising edge cases. Assume comfort with jargon. Audience: someone who already knows the basics cold and wants the interesting stuff.',
};
const DIFFICULTY_OPTIONS = DIFFICULTIES.map(value => ({ value }));

const TOPIC_SUGGESTIONS = [
  'how transformers learn',
  'rust borrow checker',
  'distributed consensus',
  'the Unix philosophy',
  'cryptography primitives',
  'GPU architecture',
  'TCP internals',
  'database indexing',
  'memory allocators',
  'compilers and codegen',
];

// ─── ANSI ─────────────────────────────────────────────────────────────────────
const A = {
  clear:      '\x1b[2J',
  home:       '\x1b[H',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  enterAlt:   '\x1b[?1049h',
  exitAlt:    '\x1b[?1049l',
  reset:      '\x1b[0m',
  bold:       '\x1b[1m',
  dim:        '\x1b[2m',
  accent:     '\x1b[38;5;147m',
  fg:         '\x1b[38;5;252m',
  mute:       '\x1b[38;5;242m',
  faint:      '\x1b[38;5;238m',
  warn:       '\x1b[38;5;179m',
};
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

// ─── state ────────────────────────────────────────────────────────────────────
const state = {
  topic:            '',
  difficulty:       'intermediate',
  drips:            [],    // committed drips, oldest → newest
  currentDrip:      '',    // what's painting on screen right now (live or last committed)
  streaming:        false, // true while tokens are arriving for the visible drip
  lookahead:        null,  // in-flight next drip — see startLookahead()
  paused:           false,
  idlePaused:       false,
  autoTimer:        null,
  idleTimer:        null,
  loadingTicker:    null,
  sessionStartedAt: null,
  error:            null,
  authMethod:       null,
  apiKey:           null,
  inputHandler:     null,
  resolveSession:   null,  // resolver for the current session's promise
  _lastRenderAt:    0,
};

// ─── fs helpers ───────────────────────────────────────────────────────────────
function ensureDirs() { fs.mkdirSync(CONFIG_DIR, { recursive: true }); }
function recordSeen(topic, drip) {
  ensureDirs();
  try {
    fs.appendFileSync(SEEN_FILE, JSON.stringify({ ts: Date.now(), topic, drip }) + '\n');
    const stat = fs.statSync(SEEN_FILE);
    if (stat.size > 1024 * 1024) {
      const lines = fs.readFileSync(SEEN_FILE, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(SEEN_FILE, lines.slice(-4000).join('\n') + '\n');
    }
  } catch {}
}

// ─── auth detection ───────────────────────────────────────────────────────────
function checkClaudeCLI() {
  return new Promise(resolve => {
    const proc = spawn('claude', ['--version'], { stdio: 'ignore' });
    proc.on('close', code => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

// Quick probe: does `claude -p` actually work (i.e. is the user signed in)?
// We send a 2-token request on Haiku (fastest, cheapest). Finishes in ~400ms
// for an authed user; fails fast for an unauthed one. Negligible cost.
function quickAuthCheck() {
  return new Promise(resolve => {
    const proc = spawn('claude', ['-p', 'hi', '--model', 'haiku'], { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {}; resolve(false); }, 8000);
    proc.on('close', code => { clearTimeout(timer); resolve(code === 0); });
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}
async function detectAuth() {
  // Test hook: DRIP_DEMO_NO_AUTH=1 forces the guided-setup flow even when
  // auth is configured. Useful for verifying the first-time-user experience.
  if (process.env.DRIP_DEMO_NO_AUTH === '1') return { method: null, key: null };
  if (await checkClaudeCLI()) return { method: 'claude', key: null };
  if (process.env.ANTHROPIC_API_KEY) return { method: 'apikey', key: process.env.ANTHROPIC_API_KEY };
  return { method: null, key: null };
}

// ─── guided setup ────────────────────────────────────────────────────────────
// When drip is run fresh with no auth configured, walk the user through it
// interactively — pick one path, set it up, continue into the session. No
// "rerun drip" dance, no exiting to a confusing TUI and coming back.
function askLine(label) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(label, ans => { rl.close(); resolve(ans.trim()); });
  });
}

async function guidedSetup() {
  const out = process.stdout;
  out.write(`\n  ${A.bold}${A.accent}drip${A.reset}${A.faint}  ·  ${A.reset}${A.fg}learn while AI thinks${A.reset}\n\n`);
  out.write(`  ${A.mute}First time? Let's get you set up — one question.${A.reset}\n`);
  out.write(`  ${A.faint}drip never sees or stores your key. all client-side.${A.reset}\n\n`);

  out.write(`  ${A.fg}Which Claude access do you want to use?${A.reset}\n\n`);
  out.write(`    ${A.accent}1${A.reset}  ${A.fg}Claude Pro / Max subscription${A.reset}  ${A.faint}(free, no per-drip cost)${A.reset}\n`);
  out.write(`    ${A.accent}2${A.reset}  ${A.fg}Anthropic API key${A.reset}              ${A.faint}(~$0.003 per drip)${A.reset}\n\n`);

  let pick = '';
  while (pick !== '1' && pick !== '2') {
    pick = await askLine(`  ${A.mute}pick${A.reset} ${A.accent}▸${A.reset} `);
    if (pick !== '1' && pick !== '2') {
      out.write(`  ${A.warn}type 1 or 2${A.reset}\n`);
    }
  }

  if (pick === '1') return await setupClaudeCode(out);
  return await setupApiKey(out);
}

async function setupClaudeCode(out) {
  out.write(`\n  ${A.accent}→${A.reset} ${A.fg}setting up claude-code${A.reset}\n\n`);

  // 1. Install claude-code if missing.
  const alreadyInstalled = await checkClaudeCLI();
  if (!alreadyInstalled) {
    out.write(`  ${A.mute}installing @anthropic-ai/claude-code (about 10 seconds)…${A.reset}\n\n`);
    const res = spawnSync('npm', ['i', '-g', '@anthropic-ai/claude-code'], { stdio: 'inherit' });
    if (res.status !== 0) {
      out.write(`\n  ${A.warn}install failed.${A.reset} try manually: ${A.fg}npm i -g @anthropic-ai/claude-code${A.reset}\n\n`);
      process.exit(1);
    }
    out.write(`\n  ${A.fg}✓${A.reset} installed.\n\n`);
  } else {
    out.write(`  ${A.fg}✓${A.reset} claude-code is installed.\n`);
  }

  // 2. Check if they're already signed in — skip the TUI round-trip if so.
  out.write(`  ${A.mute}checking whether you're already signed in…${A.reset}\n`);
  if (await quickAuthCheck()) {
    out.write(`  ${A.fg}✓${A.reset} already signed in. starting drip…\n\n`);
    await new Promise(r => setTimeout(r, 400));
    return { method: 'claude', key: null };
  }

  // 3. Not signed in — launch Claude Code once so they can log in via browser.
  out.write(`  ${A.mute}not signed in yet. I'll open Claude Code so you can log in.${A.reset}\n`);
  out.write(`  ${A.faint}a browser will open — complete the login, then type ${A.reset}${A.fg}/exit${A.reset}${A.faint} in Claude Code to come back.${A.reset}\n\n`);
  await askLine(`  ${A.mute}press enter to continue${A.reset} ${A.accent}▸${A.reset} `);
  spawnSync('claude', [], { stdio: 'inherit' });

  // 4. Verify it worked; retry guidance if not.
  out.write(`\n  ${A.mute}verifying sign-in…${A.reset}\n`);
  if (await quickAuthCheck()) {
    out.write(`  ${A.fg}✓${A.reset} signed in. starting drip…\n\n`);
    await new Promise(r => setTimeout(r, 400));
    return { method: 'claude', key: null };
  }
  out.write(`  ${A.warn}still not signed in.${A.reset} try running ${A.fg}claude${A.reset} manually, then re-run drip.\n\n`);
  process.exit(1);
}

async function setupApiKey(out) {
  out.write(`\n  ${A.accent}→${A.reset} ${A.fg}setting up an API key${A.reset}\n\n`);
  out.write(`  ${A.mute}opening console.anthropic.com/settings/keys in your browser…${A.reset}\n`);
  spawnSync('open', ['https://console.anthropic.com/settings/keys'], { stdio: 'ignore' });
  out.write(`  ${A.faint}(create an account if needed, then click "Create Key")${A.reset}\n\n`);

  const key = await askLine(`  ${A.fg}paste your key${A.reset} ${A.faint}(starts with sk-ant-)${A.reset} ${A.accent}▸${A.reset} `);

  if (!key.startsWith('sk-ant-')) {
    out.write(`\n  ${A.warn}that doesn't look right.${A.reset} keys start with ${A.fg}sk-ant-${A.reset}.\n`);
    out.write(`  ${A.mute}re-run drip to try again.${A.reset}\n\n`);
    process.exit(1);
  }

  // Offer to save it to the shell rc so they don't have to re-export next time.
  const saveAns = await askLine(`\n  ${A.mute}save this to your shell so drip works next time? (Y/n)${A.reset} ${A.accent}▸${A.reset} `);
  if (!/^n/i.test(saveAns)) {
    const shell = process.env.SHELL || '';
    const rc = shell.includes('zsh')  ? path.join(os.homedir(), '.zshrc')
             : shell.includes('fish') ? path.join(os.homedir(), '.config/fish/config.fish')
             : path.join(os.homedir(), '.bashrc');
    const line = shell.includes('fish')
      ? `\n# drip — Anthropic API key\nset -x ANTHROPIC_API_KEY ${key}\n`
      : `\n# drip — Anthropic API key\nexport ANTHROPIC_API_KEY=${key}\n`;
    try {
      fs.appendFileSync(rc, line);
      out.write(`\n  ${A.fg}✓${A.reset} saved to ${A.fg}${rc}${A.reset} ${A.faint}(takes effect in new terminals)${A.reset}\n`);
    } catch {
      out.write(`\n  ${A.warn}couldn't write to ${rc}${A.reset} — set it manually next time.\n`);
    }
  }

  out.write(`\n  ${A.fg}✓${A.reset} ${A.fg}key set. starting drip…${A.reset}\n\n`);
  await new Promise(r => setTimeout(r, 600));
  return { method: 'apikey', key };
}

// ─── streaming transports ────────────────────────────────────────────────────
// Both resolve to the full concatenated text. During the stream they call
// onDelta(chunk) so the caller can paint live.
function streamLLM(systemText, userText, onDelta) {
  if (state.authMethod === 'apikey') return streamAnthropicAPI(systemText, userText, onDelta);
  if (state.authMethod === 'claude') return streamClaudeSubprocess(systemText, userText, onDelta);
  return Promise.reject(new Error('no auth configured'));
}

async function streamAnthropicAPI(systemText, userText, onDelta) {
  const modelId = MODEL_IDS[MAIN_MODEL] || MAIN_MODEL;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type':      'application/json',
      'x-api-key':         state.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      modelId,
      max_tokens: MAX_TOKENS,
      stream:     true,
      system:     [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
      messages:   [{ role: 'user', content: userText }],
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j.error?.message || ''; } catch {}
    throw new Error(`API ${res.status}${detail ? ': ' + detail : ''}`);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', accumulated = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          const text = evt.delta.text || '';
          if (text) { accumulated += text; onDelta(text); }
        }
      } catch {}
    }
  }
  return accumulated;
}

function streamClaudeSubprocess(systemText, userText, onDelta) {
  return new Promise((resolve, reject) => {
    const args = [
      '--model', MAIN_MODEL,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '-p',
    ];
    const proc = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', accumulated = '', stderr = '';

    proc.stdout.on('data', data => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          let newText = '';

          // Partial content delta (--include-partial-messages)
          if (evt.type === 'stream_event' && evt.event?.type === 'content_block_delta'
              && evt.event.delta?.type === 'text_delta') {
            newText = evt.event.delta.text || '';
          }
          // Full-message envelope — emit diff
          else if (evt.type === 'assistant' && evt.message?.content) {
            let fullText = '';
            for (const block of evt.message.content) {
              if (block.type === 'text') fullText += block.text || '';
            }
            if (fullText.length > accumulated.length) {
              newText = fullText.slice(accumulated.length);
            }
          }
          // Bare content_block_delta (fallback)
          else if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            newText = evt.delta.text || '';
          }
          // Final result (fallback)
          else if (evt.type === 'result' && typeof evt.result === 'string') {
            if (evt.result.length > accumulated.length) {
              newText = evt.result.slice(accumulated.length);
            }
          }

          if (newText) { accumulated += newText; onDelta(newText); }
        } catch {}
      }
    });

    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code !== 0) reject(new Error(stderr.trim() || `claude exited ${code}`));
      else resolve(accumulated);
    });
    proc.on('error', err => {
      if (err.code === 'ENOENT') reject(new Error('`claude` not found in PATH'));
      else reject(err);
    });
    proc.stdin.write(`${systemText}\n\n${userText}`);
    proc.stdin.end();
  });
}

// ─── prompts ──────────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  return `You generate insight cards ("drips") on a given topic. A drip is ambient — it sits in a side window that the reader glances at passively. One glance, one complete thought.

HARD LIMITS (violations are failures):
- Exactly ONE sentence. No ". " inside.
- 8 to 10 words. Hard max is 10. Count every word before output.
- If your draft exceeds 10 words, cut or rewrite. Never ship 11+.

Audience: technically literate, low fluff tolerance. Deliver information, not explanation.

Every drip must:
- One non-obvious idea. Not a definition. Not an intro.
- Concrete: a number, a name, a mechanism, or a surprise.
- Stand alone — no "also", "another", "furthermore", no transitions.
- Never repeat or restate a drip already shown.

Banned: "Did you know", "Interestingly", "Fun fact", "essentially", "basically", "fundamentally", rhetorical questions, hedges, marketing tone.

Golden examples — same topic at each level, to show the ladder:

Topic: neural networks
  beginner (10):     Neural networks learn by nudging millions of tiny number dials.
  intermediate (10): Transformers replaced RNNs because attention runs in parallel, not sequentially.
  advanced (9):      Grokking reveals memorization and generalization as separate phase transitions.

Topic: GPUs
  beginner (10):     GPUs do many small math problems at once, not one fast.
  intermediate (10): GPUs beat CPUs for matrix math: thousands of cores versus dozens.
  advanced (10):     Tensor cores do mixed-precision matmul in a single clock cycle.

Other topics (single examples):

Topic: sloths
> Wild sloths mostly die descending trees to poop each week.   (10)

Topic: Thinking, Fast and Slow
> System 2 only engages when System 1 flags something weird.   (10)

Notice the ladder: beginner uses "dials" (analogy), intermediate uses "RNNs" (jargon without defining), advanced uses "Grokking" (named phenomenon). Same topic, three different altitudes. Match the altitude the user requested.

Output: ONE sentence, 8–10 words, plain text. No label, no quotes, no title. Just the drip.`;
}

function buildUserPrompt({ topic, difficulty, covered, index }) {
  const tone = DIFFICULTY_TONE[difficulty] || DIFFICULTY_TONE.intermediate;
  const avoid = covered?.length
    ? `\nAlready-shown drips — do NOT repeat or rephrase any of these:\n${covered.slice(-50).map((d, i) => `${i + 1}. ${d}`).join('\n')}\n`
    : '';
  const arc = index <= 5
    ? 'Depth stage: foundational. Start from the ground up.'
    : index <= 20
    ? 'Depth stage: mechanisms and named concepts. Past the basics.'
    : 'Depth stage: nuance, edge cases, frontier. Assume prior drips landed.';
  return `Generate one drip on: ${topic}
Depth: ${difficulty} — ${tone}
Drip number: ${index}. ${arc}
${avoid}
Each drip must stand alone (readable without context), but across a session drips should feel like a smart friend's walk-through of the topic — the next natural thought, not random trivia pulled from a bag.

Output only the drip itself. Nothing else.`;
}

function cleanDrip(text) {
  return text
    .replace(/^>\s*/, '')
    .replace(/^["'](.+)["']$/, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── rendering ────────────────────────────────────────────────────────────────
function term() { return { w: process.stdout.columns || 80, h: process.stdout.rows || 24 }; }

function wrap(text, width) {
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if ((cur + ' ' + w).length > width) { lines.push(cur); cur = w; }
    else cur += ' ' + w;
  }
  if (cur) lines.push(cur);
  return lines;
}

// Build the viewport body — a single card, vertically centered. Display logic:
//   1. Tokens currently painting (streaming) → show them with caret.
//   2. Streaming but no tokens yet → show a loading indicator (never blank).
//   3. Idle between cadence ticks → show the last committed drip.
//   4. Fresh session, nothing yet → loading indicator.
// Never leave the body blank: blank reads as "timed out" to the user.
function buildCardLines(bodyW, viewportH) {
  let text      = '';
  let showCaret = false;
  let loading   = false;

  if (state.currentDrip) {
    text      = state.currentDrip;
    showCaret = state.streaming;
  } else if (state.streaming) {
    // Generation kicked off, first token hasn't arrived. Clear feedback
    // that the next drip is coming — not a timed-out screen.
    text      = 'dripping…';
    loading   = true;
    showCaret = true;
  } else if (state.drips.length > 0) {
    text = state.drips[state.drips.length - 1];
  } else {
    // Very first moment of a session, before startLookahead has even fired.
    text      = 'dripping…';
    loading   = true;
    showCaret = true;
  }

  const out = [];
  const wrapped = wrap(text, bodyW);
  const color   = loading ? A.faint : A.fg;
  const painted = wrapped.map(l => `${color}${l}${A.reset}`);

  if (showCaret && painted.length > 0) {
    const lastIdx = painted.length - 1;
    painted[lastIdx] = `${color}${wrapped[lastIdx]}${A.reset}${A.accent}▍${A.reset}`;
  }

  // Vertically center the card in the viewport.
  const padTop = Math.max(0, Math.floor((viewportH - painted.length) / 2));
  for (let i = 0; i < padTop; i++) out.push('');
  for (const l of painted) out.push(l);
  while (out.length < viewportH) out.push('');
  return out;
}

function drawScreen() {
  const { w, h } = term();
  const MARGIN  = 4;                                         // left/right chrome
  let out = A.clear + A.home;

  // ── Header ───────────────────────────────────────────────────────────────
  // "drip · topic · level"  left ·  right-side status or drip count
  const count = state.drips.length + (state.streaming ? 1 : 0);

  let right = '';
  if (state.idlePaused) {
    right = `${A.faint}idle${A.reset}`;
  } else if (state.paused) {
    right = `${A.warn}paused${A.reset}`;
  } else if (count > 0) {
    // Don't duplicate a "dripping…" in the header when the body is already
    // showing the loading state — just show the drip count.
    right = `${A.faint}#${count}${A.reset}`;
  }

  const leftPlain = `drip  ·  ${state.topic}  ·  ${state.difficulty}`;
  const left      = `${A.bold}${A.accent}drip${A.reset}${A.faint}  ·  ${A.reset}${A.fg}${state.topic}${A.reset}${A.faint}  ·  ${A.reset}${A.mute}${state.difficulty}${A.reset}`;
  const rightLen  = stripAnsi(right).length;
  const headerPad = Math.max(1, w - leftPlain.length - rightLen - MARGIN);
  const header    = `  ${left}${' '.repeat(headerPad)}${right}  `;

  // A single, quiet separator below the header. No bottom rule — footer floats.
  const rule      = `  ${A.faint}${'─'.repeat(Math.max(1, w - MARGIN))}${A.reset}  `;

  // ── Footer keybar ────────────────────────────────────────────────────────
  function key(k, label) {
    return `${A.fg}${k}${A.reset} ${A.faint}${label}${A.reset}`;
  }
  const dot = `  ${A.faint}·${A.reset}  `;

  let footer;
  if (state.error) {
    footer = `  ${key('q', 'back')}${dot}${key('ctrl+c', 'exit')}  `;
  } else if (state.paused && !state.idlePaused) {
    footer = `  ${A.warn}⏸${A.reset}${dot}${key('p', 'resume')}${dot}${key('q', 'back')}  `;
  } else if (state.idlePaused) {
    footer = `  ${A.faint}idle — any key resumes${A.reset}${dot}${key('q', 'back')}  `;
  } else {
    footer = `  ${A.faint}auto-play${A.reset}${dot}${key('space', 'skip')}${dot}${key('p', 'pause')}${dot}${key('q', 'back')}  `;
  }

  // ── Layout ───────────────────────────────────────────────────────────────
  // topPad  header  rule  gapA  [body]  gapB  footer  botPad
  const topPad  = 1;
  const gapA    = 2;
  const gapB    = 2;
  const botPad  = 1;
  const chrome  = topPad + 1 + 1 + gapA + gapB + 1 + botPad;
  const viewportH = Math.max(3, h - chrome);
  const bodyW     = Math.min(w - 6, 76);

  for (let i = 0; i < topPad; i++) out += '\n';
  out += header + '\n';
  out += rule + '\n';
  for (let i = 0; i < gapA; i++) out += '\n';

  if (state.error) {
    const msg = state.error.slice(0, 180);
    const lines = [
      `${A.warn}couldn't generate drip${A.reset}`,
      '',
      `${A.mute}${msg}${A.reset}`,
      '',
      `${A.faint}press q to pick another topic${A.reset}`,
    ];
    const pad = Math.max(0, Math.floor((viewportH - lines.length) / 2));
    for (let i = 0; i < pad; i++) out += '\n';
    for (const l of lines) out += `  ${l}\n`;
    for (let i = 0; i < viewportH - pad - lines.length; i++) out += '\n';
  } else {
    const card = buildCardLines(bodyW, viewportH);
    for (const l of card) out += `  ${l}\n`;
  }

  for (let i = 0; i < gapB; i++) out += '\n';
  out += footer;
  for (let i = 0; i < botPad; i++) out += '\n';
  process.stdout.write(out);
}

function renderPartial() {
  const now = Date.now();
  if (now - state._lastRenderAt < RENDER_DEBOUNCE_MS) return;
  state._lastRenderAt = now;
  drawScreen();
}

// ─── cadence ──────────────────────────────────────────────────────────────────
function resetAutoTimer() {
  if (state.autoTimer) clearTimeout(state.autoTimer);
  state.autoTimer = setTimeout(autoTick, CADENCE_MS);
}
async function autoTick() {
  if (state.paused) { resetAutoTimer(); return; }
  await advanceToNext();
}

// Pre-generate the NEXT drip in the background. Idempotent. The tokens stream
// silently into slot.text; when a user later advances to this slot it's
// usually already done, so display is instant. If they catch it mid-stream,
// marking slot.live = true pipes token updates into state.currentDrip.
function startLookahead() {
  if (state.lookahead) return;      // already one in flight
  if (state.paused)    return;      // don't burn tokens while paused
  if (state.error)     return;

  const slot = {
    text:    '',
    done:    false,
    live:    false,
    error:   null,
    promise: null,
  };
  const systemText = buildSystemPrompt();
  const userText   = buildUserPrompt({
    topic:      state.topic,
    difficulty: state.difficulty,
    covered:    state.drips.slice(),            // snapshot at call time
    index:      state.drips.length + 1,
  });
  slot.promise = streamLLM(systemText, userText, delta => {
    slot.text += delta;
    if (slot.live) {
      state.currentDrip = slot.text;
      renderPartial();
    }
  }).catch(err => { slot.error = err; })
    .finally(() => { slot.done = true; });

  state.lookahead = slot;
}

function commitSlot(slot) {
  if (slot.error) {
    state.error = slot.error?.message || String(slot.error);
    return;
  }
  const text = cleanDrip(slot.text || '');
  if (!text) return;
  state.currentDrip = text;
  state.drips.push(text);
  recordSeen(state.topic, text);
}

// Move to the next drip. Usually instant: the lookahead slot is already done,
// so we just swap state.currentDrip. If the user advances before the slot is
// ready (rare with 30s cadence), the previous drip stays visible until the
// new one finishes streaming in.
async function advanceToNext() {
  if (state.streaming) return;

  if (!state.lookahead) startLookahead();
  const slot = state.lookahead;
  if (!slot) return;                            // blocked (paused / error)
  state.lookahead = null;
  slot.live = true;

  if (slot.done) {
    // Pre-generated — display instantly.
    commitSlot(slot);
    drawScreen();
    startLookahead();
    resetAutoTimer();
    return;
  }

  // Still in flight — immediately clear to the loading indicator so the
  // user gets clear feedback that the skip registered. Tokens will paint in
  // a moment as they arrive. If some tokens already came in silently during
  // pre-generation, we start with those.
  state.streaming   = true;
  state.currentDrip = slot.text;          // '' → loading state; partial → typewriter from there
  drawScreen();

  try { await slot.promise; } catch {}
  state.streaming = false;
  commitSlot(slot);
  drawScreen();
  startLookahead();
  resetAutoTimer();
}

// ─── input ────────────────────────────────────────────────────────────────────
function setupInput(handler) {
  if (state.inputHandler) process.stdin.off('data', state.inputHandler);
  state.inputHandler = handler;
  try { process.stdin.setRawMode(true); } catch {}
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', handler);
}
function teardownInput() {
  if (state.inputHandler) process.stdin.off('data', state.inputHandler);
  state.inputHandler = null;
  try { process.stdin.setRawMode(false); } catch {}
  process.stdin.pause();
}

function feedKey(key) {
  resetIdle();

  // Any key wakes from idle-pause, except the exit/navigation ones.
  if (state.idlePaused && key !== '\x03' && key !== 'q' && key !== 'Q') {
    state.idlePaused = false;
    state.paused     = false;
    drawScreen();
    resetAutoTimer();
    return;
  }

  if (key === '\x03') return quit();                    // ctrl+c exits the program
  if (key === 'q' || key === 'Q') return exitSession(); // q returns to topic picker

  if (state.streaming) return; // other keys wait for current stream to finish

  if (key === ' ') {
    if (state.paused) return;
    advanceToNext();
    return;
  }
  if (key === 'p' || key === 'P') {
    togglePause();
    return;
  }
}

function togglePause() {
  state.paused = !state.paused;
  if (state.paused) {
    if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
  } else {
    state.idlePaused = false;
    resetAutoTimer();
    startLookahead();                           // refill the buffer if empty
  }
  drawScreen();
}

function resetIdle() {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    if (!state.paused) {
      state.paused     = true;
      state.idlePaused = true;
      if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
      drawScreen();
    }
  }, IDLE_MS);
}

// ─── onboarding ───────────────────────────────────────────────────────────────
function brand() {
  return `${A.bold}${A.accent}drip${A.reset}${A.fg}  ·  learn while AI thinks${A.reset}`;
}

function topicPrompt() {
  process.stdout.write(A.clear + A.home);
  process.stdout.write('\n\n');
  process.stdout.write(`  ${brand()}\n`);
  process.stdout.write('\n\n');
  process.stdout.write(`  ${A.faint}pick anything — a concept, a book, a topic you've been meaning to understand${A.reset}\n`);
  process.stdout.write('\n\n');
  process.stdout.write(`  ${A.mute}for example${A.reset}\n\n`);
  for (const s of TOPIC_SUGGESTIONS) {
    process.stdout.write(`    ${A.faint}${s}${A.reset}\n`);
  }
  process.stdout.write('\n\n');
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`  ${A.mute}topic${A.reset} ${A.accent}▸${A.reset} `, ans => { rl.close(); resolve(ans); });
  });
}

function selectMenu({ header, title, options, defaultIdx = 0, allowEsc = false }) {
  let sel = defaultIdx;
  const displayOf = o => (o.label ?? o.value ?? '');
  const labelWidth = Math.max(...options.map(o => displayOf(o).length));

  function render() {
    let out = A.clear + A.home + '\n\n';
    if (header) out += `  ${header}\n\n\n`;
    if (title)  out += `  ${A.mute}${title}${A.reset}\n\n`;
    options.forEach((opt, i) => {
      const chosen   = i === sel;
      const marker   = chosen ? `${A.accent}▸${A.reset}` : ' ';
      const labelClr = chosen ? A.fg : A.mute;
      const label    = displayOf(opt).padEnd(labelWidth);
      out += `    ${marker} ${labelClr}${label}${A.reset}\n`;
    });
    out += '\n';
    const hint = allowEsc
      ? `  ${A.faint}↑↓${A.reset} ${A.faint}move${A.reset}   ${A.faint}enter${A.reset} ${A.faint}select${A.reset}   ${A.faint}esc${A.reset} ${A.faint}back${A.reset}\n`
      : `  ${A.faint}↑↓${A.reset} ${A.faint}move${A.reset}   ${A.faint}enter${A.reset} ${A.faint}select${A.reset}\n`;
    out += hint;
    process.stdout.write(out);
  }
  render();

  return new Promise(resolve => {
    function cleanup() {
      process.stdin.off('data', handler);
      try { process.stdin.setRawMode(false); } catch {}
      process.stdin.pause();
    }
    function handler(key) {
      if (key === '\x03') { cleanup(); resolve(null); return; }
      if (allowEsc && key === '\x1b') { cleanup(); resolve('__ESC__'); return; }
      if (key === '\x1b[A' || key === 'k') { sel = (sel - 1 + options.length) % options.length; render(); return; }
      if (key === '\x1b[B' || key === 'j') { sel = (sel + 1) % options.length; render(); return; }
      if (key === '\r' || key === '\n') { cleanup(); resolve(options[sel].value); }
    }
    try { process.stdin.setRawMode(true); } catch {}
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', handler);
  });
}

async function runOnboarding(prefill = {}) {
  let topic      = prefill.topic;
  let difficulty = prefill.difficulty;

  while (!topic) {
    const ans = await topicPrompt();
    topic = (ans || '').trim();
  }
  if (!difficulty) {
    const pick = await selectMenu({
      header:     brand(),
      title:      'level',
      options:    DIFFICULTY_OPTIONS,
      defaultIdx: 1,
      allowEsc:   true,
    });
    if (pick === null) return null;
    if (pick === '__ESC__') return runOnboarding({});
    difficulty = pick;
  }
  return { topic, difficulty };
}

// ─── alt screen + lifecycle ───────────────────────────────────────────────────
function enterAlt() { process.stdout.write(A.enterAlt + A.hideCursor); }
function exitAlt()  { process.stdout.write(A.showCursor + A.exitAlt); }

function startLoadingTicker() {
  if (state.loadingTicker) return;
  state.loadingTicker = setInterval(() => {
    if (state.drips.length === 0 && !state.currentDrip && !state.error) drawScreen();
  }, 1000);
}
function stopLoadingTicker() {
  if (state.loadingTicker) { clearInterval(state.loadingTicker); state.loadingTicker = null; }
}

// Returns a promise that resolves when the user presses q (back to picker).
// Ctrl+C exits the program entirely.
function startSession({ topic, difficulty }) {
  return new Promise(resolve => {
    state.resolveSession   = resolve;
    state.topic            = topic;
    state.difficulty       = difficulty;
    state.drips            = [];
    state.currentDrip      = '';
    state.streaming        = false;
    state.lookahead        = null;
    state.paused           = false;
    state.idlePaused       = false;
    state.error            = null;
    state.sessionStartedAt = Date.now();

    enterAlt();
    setupInput(feedKey);
    process.stdout.on('resize', () => { if (!state.streaming) drawScreen(); });
    startLoadingTicker();
    resetIdle();
    drawScreen();

    // Kick off generation of the first drip, then immediately consume it so
    // the user sees it stream in. Every subsequent drip is already waiting.
    startLookahead();
    advanceToNext();
  });
}

// Tear down the current session but keep the program running. Returns the
// user to the topic picker.
function exitSession() {
  if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
  if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
  stopLoadingTicker();
  teardownInput();
  exitAlt();
  const resolve = state.resolveSession;
  state.resolveSession = null;
  if (resolve) resolve();
}

// Full program exit (Ctrl+C, SIGINT/SIGTERM, or fatal error).
function quit() {
  if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = null; }
  if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
  stopLoadingTicker();
  teardownInput();
  exitAlt();
  process.stdout.write('\n');
  process.exit(0);
}
process.on('SIGINT',  quit);
process.on('SIGTERM', quit);

// ─── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { topic: '', difficulty: null, help: false, version: false };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
    else if (a === '--level' || a === '-l') out.difficulty = args[++i];
    else if (a.startsWith('--level=')) out.difficulty = a.slice(8);
    else rest.push(a);
  }
  out.topic = rest.join(' ');
  if (out.difficulty) {
    const m = DIFFICULTIES.find(d => d.startsWith(out.difficulty.toLowerCase()));
    out.difficulty = m || null;
  }
  return out;
}

// ─── main ─────────────────────────────────────────────────────────────────────
(async function main() {
  const nv = parseInt(process.versions.node.split('.')[0], 10);
  if (nv < 18) { console.error(`drip requires Node 18+. You have ${process.versions.node}.`); process.exit(1); }

  const cli = parseArgs(process.argv);

  if (cli.help) {
    console.log(`\n  ${A.bold}${A.accent}drip${A.reset}  ${A.fg}learn while AI thinks${A.reset}`);
    console.log(`  ${A.mute}auto-plays one insight card every 10s${A.reset}\n`);
    console.log(`  usage: drip [topic] [--level beginner|intermediate|advanced]\n`);
    console.log(`  keys in the panel:`);
    console.log(`    space   skip ahead  ${A.mute}(don't wait for the 10s tick)${A.reset}`);
    console.log(`    p       pause / resume auto-play`);
    console.log(`    q       back to topic picker`);
    console.log(`    ctrl+c  exit drip\n`);
    console.log(`  auth (auto-detected, prefers free):`);
    console.log(`    ${A.accent}1.${A.reset} claude CLI            ${A.mute}# free with Claude Pro/Max${A.reset}`);
    console.log(`    ${A.accent}2.${A.reset} ANTHROPIC_API_KEY     ${A.mute}# fallback, direct to Anthropic${A.reset}\n`);
    console.log(`  env: DRIP_MODEL=sonnet|opus|haiku  ${A.mute}# default: sonnet${A.reset}\n`);
    process.exit(0);
  }
  if (cli.version) {
    console.log(require('./package.json').version);
    process.exit(0);
  }

  let auth = await detectAuth();
  if (!auth.method) {
    // Run the interactive setup — one question, walk them through, land in drip.
    auth = await guidedSetup();
  }
  state.authMethod = auth.method;
  state.apiKey     = auth.key;

  ensureDirs();

  // Loop: topic picker → session → topic picker → session → …
  // q inside a session returns here. Ctrl+C exits the program.
  let prefill = {
    topic:      cli.topic || undefined,
    difficulty: cli.difficulty || undefined,
  };
  while (true) {
    const choice = await runOnboarding(prefill);
    if (!choice) { quit(); return; }
    prefill = {};                                 // only use CLI args for the first round
    await startSession(choice);
  }
})().catch(err => {
  exitAlt();
  console.error(`\n${A.warn}fatal:${A.reset} ${err?.message || err}\n`);
  process.exit(1);
});
