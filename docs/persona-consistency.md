# Keeping a bot in-character — anti-drift playbook (fleet-wide)

> Why a strong system prompt still drifts to "helpful assistant" tone, and what actually fixes it.
> Distilled from research 2026-06-27 (trigger: זורו going soft on a member's check-in). Applies to
> any persona bot (זורו's harsh coach, but also דיגיט/פיצי voice consistency). Sources at bottom.

## The core mechanism
Drift happens because **the persona instruction sits at the top of the prompt and gets *further* from
the generation point as the chat grows, while the RLHF "warm / agreeable / validating" prior is always
present at generation.** So the high-leverage fixes are about **position, repetition, and pulling safety
out of the persona's hands** — not writing more adjectives.

**The single most useful Claude-specific fact:** Claude's constitution puts *"don't demean a person's
worth / don't encourage self-destruction"* **above any persona rule**. So when a persona pushes toward
degrading the *person*, Claude reverts to a safe/soft tone — the exact "it went soft" symptom. Aim
contempt at the **behavior / cigarette / excuse**, never the person's inherent worth. That keeps it
brutal *without* tripping the constitutional revert.

## Tier 1 — highest leverage
1. **Re-inject a compact persona block at shallow depth every turn** (SillyTavern "Author's Note /
   post-history" idea: last-position text influences the next reply most). In OpenClaw we approximate
   this by (a) keeping sessions SMALL via session-hygiene so the top-of-prompt persona stays close, and
   (b) putting the critical tone rules + a negative example in `AGENTS.md` (always injected). A true
   per-turn bottom-injection would need a gateway hook — open item if drift persists.
2. **Separate crisis safety from the persona.** A safety *clause* is necessary but proven insufficient
   under pressure. Best practice = a cheap pre-classifier/hard rule that routes a real crisis to a
   fixed plain response **before** the persona generates. Lets you max out toughness with zero risk to
   the floor. (Heavier — a hook/tool. Recommended next step for זורו.)
3. **Reframe toughness as the clinically-correct move: "acknowledge once, then push to action — never
   validate twice in a row."** Repeated validation is the documented multi-turn failure (users get
   *more* hopeless by turn ~12). This makes toughness and safety *aligned*, not opposed.

## Tier 2 — strong, low-effort prompt structure
4. **Convert "don'ts" to "dos".** Bare negations cause "ironic rebound" (raise the forbidden content's
   probability). Say "stay aggressive / mock the excuse first," not "don't be soft." If a hard
   prohibition is unavoidable, **repeat it**.
5. **2-3 on-voice dialogue exemplars, best one LAST; ban assistant formatting** (no bullets/markdown/
   "summary" — the moment output becomes a tidy list it has slid into assistant register).
6. **Write the opening message exactly in-voice** (sets style+length more than instructions) and
   **pre-script replies to common excuses** ("only had one", "stressful week", "I'll quit Monday") —
   those are exactly where it breaks to comfort.
7. **Labeled contrastive good-vs-bad example pairs** (`✅ in-voice` next to `❌ too-soft/assistant`) for
   the same user message. This is the *safe* way to show "what not to do" — as a labeled example, NOT a
   negated instruction (#4). Beats standard few-shot (CICL).

## Tier 3 — Claude-specific
8. **Wrap persona/rules/crisis-floor in XML tags** (`<persona>`, `<tone_rules>`, `<crisis_floor>`) —
   Claude parses and adheres better than to plain prose.
9. **Design the persona to attack the excuse/cigarette, not the person's worth** (see core mechanism) —
   this is the line Claude *won't* refuse, so it sustains the toughness instead of reverting.
10. **Acknowledge the feeling, never endorse the excuse.** The reassurance reflex is baked-in RLHF
    sycophancy — counter it every turn; name the failure explicitly ("do NOT switch to soft
    generic-assistant tone when the member sounds down").
- ⚠️ **Prefill caveat:** prefilling Claude's reply to skip the friendly preamble **400s on current
  frontier Claude** (Opus/Sonnet 4.6+). Don't build on it; use system-prompt + (1) instead.

## Tier 4 — heavier machinery (only if Tiers 1-3 don't hold)
11. **Single critique-then-rewrite pass** against a persona rubric (draft → localize the off-voice line
    → rewrite). Tone is the *favorable* case for self-correction (surface-level, easy to verify) —
    unlike reasoning-correctness where self-critique fails. ~2-3× tokens; do ONE pass or judge-gate.
    A cheap in-prompt version: "before sending, reread — if it comforts/explains/sounds like an
    assistant, rewrite in voice" (applied to זורו).
12. **Persistent "lessons" memory loop (teach-as-you-go / Reflexion).** When the owner corrects the bot
    mid-chat, store a short verbal lesson to a file that's **re-injected each session**. Improves
    adherence over time — *but only as good as the correction signal* (needs the owner's or a judge's
    feedback). Cheaper/faster than fine-tuning; the right "teach it on the fly" mechanism. (זורו:
    `data/memory/lessons.md`, now read at every session open; permanent changes go via
    `prompt-self-extend.md` → AGENTS/SOUL.)
13. **Fine-tuning / dedicated persona model — not yet.** Only after prompt + few-shot + memory loop
    demonstrably plateau and you have a corpus of accepted in-voice exchanges. Slower, costlier, needs
    curated data, can erode safety. Awkward on a Max-5x OAuth subscription anyway.

## Sources
SillyTavern author's-note / character design · arXiv 2511.12381 (negation/ironic rebound) ·
gadlet.com negative-prompting · arXiv 2401.17390 (contrastive ICL) · latitude.so style consistency ·
Anthropic: keep-Claude-in-character, claude-character, constitution, sycophancy research,
protecting-well-being-of-users, agentic-misalignment · arXiv 2303.17651 (Self-Refine), 2303.11366
(Reflexion), 2310.01798 (when self-correction fails) · arxiv 2602.22775 (therapy-bot multi-turn failure).
