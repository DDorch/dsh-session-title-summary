/**
 * Rolling-summary core: the prompt that folds an existing summary together
 * with a new event digest into an updated summary plus a title, and the
 * strict JSON result parser. Pure functions — the LLM call itself lives in
 * the host half.
 *
 * Summary format: a nested outline of "major topic - minor topic" lines that
 * covers the WHOLE session (everything stays present; older topics keep one
 * short bullet, the current topic keeps concrete detail). Title: focuses on
 * the CURRENT task only.
 */

import { LANGUAGE_NAMES, type SessionLanguage } from './language.ts'

/** JSON result the model must return: updated summary + a concise title. */
export interface SummaryResult {
  summary: string
  title: string
}

/** Bounds for one generated summary (keeps the rolling file compact AND well
 * under the summarizer subagent's token budget. A 1000-char CJK outline plus
 * JSON wrapper plus title stays comfortably inside even a modest output cap;
 * structured-output JSON escaping + reasoning eat extra tokens, so smaller is
 * safer.) */
export const SUMMARY_MAX_CHARS = 1000

/** Bound the model's total output budget before parsing. */
export const RESULT_MAX_CHARS = 4096

/** Display width of one character: CJK/full-width chars count as 2, ASCII
 * and half-width chars count as 1 (two ASCII chars = one CJK char). */
function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  // CJK unified ideographs, full-width forms, hangul, kana, and other wide ranges.
  if (
    (code >= 0x1100 && code <= 0x115F) || // Hangul Jamo
    (code >= 0x2E80 && code <= 0xA4CF) || // CJK Radicals .. Yi
    (code >= 0xAC00 && code <= 0xD7A3) || // Hangul Syllables
    (code >= 0xF900 && code <= 0xFAFF) || // CJK Compatibility Ideographs
    (code >= 0xFE30 && code <= 0xFE4F) || // CJK Compatibility Forms
    (code >= 0xFF00 && code <= 0xFF60) || // Full-width Forms
    (code >= 0xFFE0 && code <= 0xFFE6) || // Full-width Signs
    (code >= 0x20000 && code <= 0x2FFFD) // CJK Extension B..
  ) {
    return 2
  }
  return 1
}

/** Display width of a string (two ASCII chars = one CJK char). */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += charWidth(ch)
  return width
}

/**
 * Fit a title into a display-width budget WITHOUT breaking its meaning and
 * WITHOUT losing the "major topic - minor topic" structure. The "-" join is
 * preserved whenever possible; both sides are compressed at token boundaries
 * (never mid-word, never mid-CJK-word). Only if the minor topic is squeezed
 * to nothing do we fall back to the bare major topic.
 * @param title - the model-produced title.
 * @param maxCjkChars - maximum CJK-character count (default 10).
 * @returns a width-bounded title that keeps both sides when it can.
 */
export function truncateTitleByWidth(title: string, maxCjkChars: number = 10): string {
  const maxWidth = maxCjkChars * 2
  const trimmed = title.trim()
  if (trimmed === '') return ''

  // Split into token runs (CJK runs and non-CJK runs) so a word is never cut.
  const tokens = splitTokens(trimmed)
  // A trailing standalone dash ("插件发布 -") has no minor topic behind it;
  // drop it so a dangling dash never survives, even when the title fits.
  while (tokens.length > 0 && /^[–—-]$/.test(tokens[tokens.length - 1].trim())) tokens.pop()
  const cleaned = tokens.join('')
  if (cleaned === '') return ''

  // 1. Fits as-is.
  if (displayWidth(cleaned) <= maxWidth) return cleaned

  // 2. Dash-joined "major - minor" title: try to keep BOTH sides. A few budget
  // splits are tried so a long minor topic gets a chance before either side is
  // sacrificed. If only one side can survive, prefer the complete major topic —
  // never a title that ends in a bare "-".
  const dashIndex = tokens.findIndex((t) => t === '-' || t === '–' || t === '—' || t === ' - ' || t.trim() === '-')
  const hasDash = dashIndex !== -1 && dashIndex < tokens.length - 1
  if (hasDash) {
    const majorTokens = tokens.slice(0, dashIndex)
    const minorTokens = tokens.slice(dashIndex + 1)
    // Reserve width for the dash and one space.
    const spaceForSides = maxWidth - 2 // "-" + one space
    for (const majorShare of [0.55, 0.45, 0.5]) {
      const major = fitTokens(majorTokens, spaceForSides * majorShare)
      const minor = fitTokens(minorTokens, spaceForSides * (1 - majorShare))
      const joined = `${major} - ${minor}`.trim()
      if (major !== '' && minor !== '' && displayWidth(joined) <= maxWidth) return joined
    }
    // One side was squeezed out entirely — keep a complete major topic.
    const majorOnly = fitTokens(majorTokens, maxWidth)
    if (majorOnly !== '') return majorOnly
    // The major alone does not fit either; keep the longest prefix of the minor.
    return fitTokens(minorTokens, maxWidth)
  }

  // 3. No dash: truncate at token boundaries.
  return fitTokens(tokens, maxWidth)
}

/** Split a string into CJK-run and non-CJK-run tokens (words never split). */
function splitTokens(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  for (const ch of text) {
    const wide = charWidth(ch) === 2
    if (current !== '' && wide !== (charWidth(current[0]) === 2)) {
      tokens.push(current)
      current = ch
    } else {
      current += ch
    }
  }
  if (current !== '') tokens.push(current)
  return tokens
}

/** Keep the longest prefix of tokens that fits the width budget. */
function fitTokens(tokens: string[], maxWidth: number): string {
  let width = 0
  const kept: string[] = []
  for (const token of tokens) {
    if (width + displayWidth(token) > maxWidth) break
    kept.push(token)
    width += displayWidth(token)
  }
  return kept.join('').trim()
}

/**
 * Build the system instruction for the folding call.
 * @param targetWords - target title length in words (non-CJK).
 * @param targetCjkCharacters - target title length in CJK characters.
 * @param language - explicit output language (e.g. "fr", "English"); wins
 *   over everything else.
 * @param detected - the language detected from the user's recent messages;
 *   used when no explicit `language` is set. A CONCRETE language name is
 *   injected, because a soft "match the user's language" instruction is
 *   ignored by CJK-defaulting backends.
 * @returns the system prompt text.
 */
export function buildSystemPrompt(
  targetWords: number = 6,
  targetCjkCharacters: number = 10,
  language?: string,
  detected?: SessionLanguage,
): string {
  const explicitLanguage = language?.trim()
  // Language coherence, in decreasing order of authority:
  // 1. an explicit `language` setting (user choice);
  // 2. the language DETECTED from the user's recent messages — named
  //    concretely in the prompt (a CJK-defaulting backend ignores a soft
  //    "match the user's language" instruction);
  // 3. fallback: the language of the user's messages (undetectable).
  let languageRule: string[]
  if (explicitLanguage !== undefined && explicitLanguage !== '') {
    languageRule = [
      `LANGUAGE RULE: write every summary line and the title in ${explicitLanguage}.`,
    ]
  } else if (detected !== undefined && detected !== 'other') {
    languageRule = [
      `LANGUAGE RULE: write every summary line and the title in ${LANGUAGE_NAMES[detected]} — the user's current working language.`,
      'Never write in any other language, including your default language.',
    ]
  } else {
    languageRule = [
      'LANGUAGE RULE: write every summary line and the title in the SAME LANGUAGE as the user\'s own messages in the "New work" digest.',
      'Never fall back to a default model language (for example, never write in Chinese when the user writes in French or English).',
    ]
  }
  return [
    'You are a session-summary assistant for an AI coding tool.',
    'You maintain a rolling outline of EVERYTHING the user and the assistant did in this session.',
    '',
    ...languageRule,
    'LANGUAGE CONTINUITY: the "Old summary" may be in a DIFFERENT language (it was written by a previous',
    'folding pass). Restate EVERY topic of the old summary in the target language above. Never copy or',
    'append a line in the old summary\'s language when the target language differs.',
    '',
    'Definitions:',
    '- "Major topic": the session-level GOAL the user is working toward — the overall thing being built or done, e.g. "Build title-summary plugin", "Organize photo archive".',
    '- "Minor topic": one specific item UNDER that major topic — a concrete step, issue, or fix, e.g. "fix subagent output token limit", "tune summary format".',
    '',
    'You receive:',
    '- "Old summary": the previous outline of everything that happened BEFORE the new work.',
    '- "New work": a fresh digest of the most recent user messages, assistant replies, and tool calls, newest at the END.',
    '',
    'Produce a single JSON object with exactly two keys:',
    '- "summary": the UPDATED outline, covering the WHOLE session — nothing important is dropped. ',
    '  Every line is ONE bullet of the form "major topic - minor topic", joined with a "-". ',
    '  The major topic names the GOAL; the minor topic names the specific item under it. ',
    '  Example lines: "Build title-summary plugin - fix subagent output token limit", "Organize photo archive - extract and classify". ',
    '  Group lines by major topic: lines of the same major topic stay together, and different major topics ',
    '  are separated by a blank line. ',
    '  Keep every topic that still matters from the old summary (ONE short bullet each — a few words, not a sentence), and add the new work. ',
    '  The CURRENT major topic gets up to 3-4 bullets with a little detail (file names, commands, outcomes); ',
    '  older major topics stay as one brief bullet each. Be terse: every bullet is short.',
    `  Keep the whole outline under ${SUMMARY_MAX_CHARS} characters.`,
    '',
    '  Example shape:',
    '  Build title-summary plugin - architecture (agent/turn-stopping + subagent)',
    '  Build title-summary plugin - fix subagent output token limit',
    '  Build title-summary plugin - current: tune summary format',
    '',
    '  Organize photo archive - extract and classify',
    '  Organize photo archive - sort by person',
    '',
    '- "title": a concise session title reflecting the CURRENT work — the overall GOAL first, then the specific item being handled right now, ',
    '  in the same "major topic - minor topic" form. ',
    '  Example: "Summarize - fix", NOT a run-on sentence. ',
    '  Base it on the NEWEST work at the END of the digest, NOT on how the session started. ',
    '  Early topics are background and must NOT dominate the title. ',
    `  WIDTH RULE: the title must fit ${targetCjkCharacters} CJK characters — each CJK/full-width char counts as 1 CJK, `,
    `  every 2 ASCII/half-width chars count as 1 CJK (so at most ${targetCjkCharacters * 2} ASCII chars). `,
    `  For non-CJK (latin-script) titles, aim for about ${targetWords} words. `,
    '  The MAJOR topic must be SHORT (about 3-5 CJK chars or 2-3 words) so the "-" and the minor topic still fit. ',
    '  The MINOR topic must also be SHORT (about 2-4 CJK chars or 1-2 words); if space is tight, shorten it further. ',
    '  Never output a bare "major -" with no minor topic after the dash.',
    '  Never write a full package or file name. ',
    `  That is a HARD LIMIT of ${targetCjkCharacters} CJK characters. `,
    '  Examples within the limit: "Plugin fix - title", "Summarize - fix".',
    '',
    'Rules:',
    '- Return ONLY the JSON object. No markdown fences, no commentary, no trailing text.',
    '- The summary must be self-contained (it replaces the old summary).',
    '- Never invent facts that are not in the old summary or the new work.',
    '- If the session has no title yet, the title names the current task; if it has one, update it to the newest focus.',
    `- LANGUAGE REMINDER: every line of "summary" and the "title" in ${explicitLanguage !== undefined && explicitLanguage !== '' ? explicitLanguage : detected !== undefined && detected !== 'other' ? LANGUAGE_NAMES[detected] : 'the user\'s own language'}.`,
  ].join('\n')
}

/**
 * Frame one folding request: the old summary plus the new digest.
 * @param oldSummary - previous rolling summary, or undefined on first fold.
 * @param newDigest - digest of the newest events.
 * @returns the user-message text.
 */
export function buildUserPrompt(oldSummary: string | undefined, newDigest: string): string {
  const parts: string[] = []
  parts.push(`<old summary>\n${oldSummary === undefined || oldSummary.trim() === '' ? '(none — this is the first fold)' : oldSummary.trim()}`)
  parts.push(`<new work>\n${newDigest.trim()}`)
  return parts.join('\n\n')
}

/**
 * Parse the model's raw output as a {@link SummaryResult}. Tolerates a
 * surrounding markdown fence; requires both keys, non-empty strings, and a
 * sane size bound.
 * @param raw - the model's raw output text.
 * @returns the parsed result, or undefined when the output is not usable.
 */
export function parseSummaryResult(raw: string): SummaryResult | undefined {
  let text = raw.trim()
  if (text.length > RESULT_MAX_CHARS) return undefined
  // Strip one optional ```json ... ``` fence.
  const fenced = /^```(?:json)?\s*([\s\S]*?)```\s*$/.exec(text)
  if (fenced !== null) text = fenced[1].trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const summary = typeof record.summary === 'string' ? record.summary.trim() : ''
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  if (summary === '' || title === '') return undefined
  return { summary: summary.slice(0, SUMMARY_MAX_CHARS), title }
}

/**
 * Fold one rolling-summary step: given the old state (or none) and the
 * parsed result, produce the next durable state.
 * @param oldSummary - previous summary text, or undefined.
 * @param result - the parsed folding result.
 * @returns the next summary text (the folded summary, bounded).
 */
export function nextSummary(oldSummary: string | undefined, result: SummaryResult): string {
  // The model already folded old + new; we only bound it defensively.
  return result.summary.slice(0, SUMMARY_MAX_CHARS)
}
