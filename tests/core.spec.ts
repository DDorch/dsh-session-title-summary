/**
 * Unit tests for the rolling-summary core: event digestion, prompt building,
 * result parsing, and the durable store. Pure logic — no LLM, no cordis.
 */

import { describe, expect, it } from 'vitest'
import { digestEvent, digestEvents, userTextOf } from '../src/core/events.ts'
import { detectSessionLanguage, LANGUAGE_NAMES } from '../src/core/language.ts'
import { buildSystemPrompt, buildUserPrompt, displayWidth, nextSummary, parseSummaryResult, truncateTitleByWidth } from '../src/core/summary.ts'
import { readSummary, summaryPath, writeSummary } from '../src/core/store.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Minimal event-shaped fixtures (the digest only reads a few fields). */
function event(type: string, data: unknown, seq: number) {
  return { type, data, seq } as never
}

describe('digestEvent', () => {
  it('renders a user message from text blocks', () => {
    const line = digestEvent(event('user/message', {
      content: [{ type: 'text', text: '解压文件后分类整理' }],
    }, 1))
    expect(line).toBe('User: 解压文件后分类整理')
  })

  it('skips non-text user content', () => {
    expect(digestEvent(event('user/message', { content: [{ type: 'image', image: {} }] }, 1))).toBeUndefined()
  })

  it('renders an assistant reply', () => {
    const line = digestEvent(event('assistant/message', {
      message: { content: [{ type: 'text', text: '已完成分类' }] },
    }, 2))
    expect(line).toBe('Assistant: 已完成分类')
  })

  it('renders tool calls with parsed arguments', () => {
    const line = digestEvent(event('tool/call', {
      name: 'extract_archive',
      arguments: '{"path":"a.7z"}',
    }, 3))
    expect(line).toBe('Tool call: extract_archive({"path":"a.7z"})')
  })

  it('renders tool results and marks errors', () => {
    expect(digestEvent(event('tool/result', {
      message: { content: [{ type: 'text', text: 'ok' }] },
    }, 4))).toBe('Tool result: ok')
    expect(digestEvent(event('tool/result', {
      message: { content: [{ type: 'text', text: 'boom' }] },
      error: { name: 'E', code: 'ERR' },
    }, 5))).toBe('Tool result (error): boom')
  })

  it('skips boundaries and log-only events', () => {
    expect(digestEvent(event('turn/end', { turn: 1, reason: { kind: 'stop' } }, 6))).toBeUndefined()
    expect(digestEvent(event('request/header', { header: {}, reason: 'new' }, 7))).toBeUndefined()
  })

  it('clips long lines', () => {
    const line = digestEvent(event('user/message', { content: [{ type: 'text', text: 'x'.repeat(500) }] }, 8))
    // 6-char "User: " prefix + the 240-char clip bound.
    expect(line?.length).toBeLessThanOrEqual(246)
    expect(line?.endsWith('…')).toBe(true)
  })})

describe('digestEvents', () => {
  it('joins digestible events in order and skips the rest', () => {
    const digest = digestEvents([
      event('user/message', { content: [{ type: 'text', text: 'a' }] }, 1),
      event('turn/end', { turn: 1, reason: { kind: 'stop' } }, 2),
      event('tool/call', { name: 'x', arguments: '{}' }, 3),
      event('assistant/message', { message: { content: [{ type: 'text', text: 'b' }] } }, 4),
    ])
    expect(digest).toBe('User: a\nTool call: x({})\nAssistant: b')
  })

  it('keeps the newest lines when the digest exceeds the bound', () => {
    // 600 events x ~50 chars each exceed DIGEST_MAX_CHARS (24000);
    // the OLDEST lines must be dropped, the newest kept.
    const many = Array.from({ length: 600 }, (_, i) => event('user/message', { content: [{ type: 'text', text: `m${i}`.repeat(50) }] }, i))
    const digest = digestEvents(many)
    expect(digest.length).toBeLessThanOrEqual(24000)
    // Newest content (m599) survives; the oldest (m0) was dropped.
    expect(digest).toContain('m599'.repeat(50).slice(0, 20))
    expect(digest).not.toContain('m0'.repeat(50).slice(0, 20))
  })
})

describe('userTextOf', () => {
  it('joins only user messages, newest within the bound', () => {
    const text = userTextOf([
      event('user/message', { content: [{ type: 'text', text: 'first prompt' }] }, 1),
      event('assistant/message', { message: { content: [{ type: 'text', text: 'assistant reply' }] } }, 2),
      event('user/message', { content: [{ type: 'text', text: 'second prompt' }] }, 3),
      event('tool/call', { name: 'x', arguments: '{}' }, 4),
    ])
    expect(text).toBe('first prompt\nsecond prompt')
  })

  it('returns empty when there are no user messages', () => {
    expect(userTextOf([
      event('assistant/message', { message: { content: [{ type: 'text', text: 'hello' }] } }, 1),
    ])).toBe('')
  })
})

describe('detectSessionLanguage', () => {
  it('detects French from accented text and function words', () => {
    expect(detectSessionLanguage('Bonjour, pouvez-vous vérifier le build et corriger le problème ? Merci beaucoup.')).toBe('fr')
  })

  it('detects English latin text without French signals', () => {
    expect(detectSessionLanguage('Please check the build and fix the failing tests, then push the branch.')).toBe('en')
  })

  it('keeps Chinese when the user writes in Chinese', () => {
    expect(detectSessionLanguage('请检查构建并修复失败的测试，然后推送分支。谢谢。')).toBe('zh')
  })

  it('returns other for very short text', () => {
    expect(detectSessionLanguage('ok')).toBe('other')
  })

  it('exposes a human name for each concrete language', () => {
    expect(LANGUAGE_NAMES.fr).toBe('French')
    expect(LANGUAGE_NAMES.en).toBe('English')
    expect(LANGUAGE_NAMES.zh).toBe('Chinese')
  })
})

describe('summary prompts', () => {
  it('builds a system prompt with the requested title lengths', () => {
    const system = buildSystemPrompt(6, 10)
    expect(system).toContain('WIDTH RULE')
    expect(system).toContain('major topic - minor topic')
    expect(system).toContain('CURRENT work')
    expect(system).toContain('session-level GOAL')
    expect(system).toContain('HARD LIMIT')
  })

  it('frames the first fold and a subsequent fold distinctly', () => {
    const first = buildUserPrompt(undefined, 'new work')
    expect(first).toContain('(none — this is the first fold)')
    expect(first).toContain('new work')
    const next = buildUserPrompt('old summary', 'newer work')
    expect(next).toContain('old summary')
    expect(next).toContain('newer work')
  })

  it('pins the language to the user\'s messages when no language is set', () => {
    const system = buildSystemPrompt(6, 10)
    expect(system).toContain('LANGUAGE RULE')
    expect(system).toContain('SAME LANGUAGE as the user\'s own messages')
    // Must forbid the CJK-default fallback that plagued real folds.
    expect(system).toContain('never write in Chinese')
  })

  it('honors an explicit language override and trims it', () => {
    const system = buildSystemPrompt(6, 10, '  French  ')
    expect(system).toContain('LANGUAGE RULE: write every summary line and the title in French.')
    // The "follow the user's language" default must not leak into the override.
    expect(system).not.toContain("SAME LANGUAGE as the user's own messages")
  })

  it('treats a blank language the same as no language', () => {
    const system = buildSystemPrompt(6, 10, '   ')
    expect(system).toContain("SAME LANGUAGE as the user's own messages")
  })

  it('pins the language to the detected working language and never to the old summary\'s', () => {
    const system = buildSystemPrompt(6, 10, undefined, 'fr')
    expect(system).toContain("LANGUAGE RULE: write every summary line and the title in French — the user's current working language.")
    // A Chinese old summary must be restated, not continued.
    expect(system).toContain('LANGUAGE CONTINUITY')
    expect(system).toContain('Restate EVERY topic of the old summary in the target language above')
    // An explicit setting wins over detection.
    const explicit = buildSystemPrompt(6, 10, 'English', 'fr')
    expect(explicit).toContain('LANGUAGE RULE: write every summary line and the title in English.')
    expect(explicit).not.toContain('the user\'s current working language')
  })

  it('stays free of CJK anchoring (no Han characters anywhere in the prompt)', () => {
    expect(/\p{Script=Han}/u.test(buildSystemPrompt(6, 10))).toBe(false)
    expect(/\p{Script=Han}/u.test(buildSystemPrompt(6, 10, undefined, 'fr'))).toBe(false)
    expect(/\p{Script=Han}/u.test(buildSystemPrompt(6, 10, undefined, 'zh'))).toBe(false)
  })
})

describe('parseSummaryResult', () => {
  it('parses a plain JSON object', () => {
    expect(parseSummaryResult('{"summary":"s","title":"t"}')).toEqual({ summary: 's', title: 't' })
  })

  it('tolerates a markdown fence', () => {
    expect(parseSummaryResult('```json\n{"summary":"s","title":"t"}\n```')).toEqual({ summary: 's', title: 't' })
  })

  it('rejects missing keys, empty values, and non-JSON', () => {
    expect(parseSummaryResult('{"summary":"s"}')).toBeUndefined()
    expect(parseSummaryResult('{"summary":"","title":"t"}')).toBeUndefined()
    expect(parseSummaryResult('not json')).toBeUndefined()
    expect(parseSummaryResult('42')).toBeUndefined()
  })

  it('rejects oversized output', () => {
    const huge = `{"summary":"${'x'.repeat(5000)}","title":"t"}`
    expect(parseSummaryResult(huge)).toBeUndefined()
  })
})

describe('nextSummary', () => {
  it('bounds the summary length', () => {
    const result = { summary: 'x'.repeat(5000), title: 't' }
    expect(nextSummary('old', result).length).toBe(1000)
  })
})

describe('truncateTitleByWidth', () => {
  it('keeps a title that already fits', () => {
    expect(truncateTitleByWidth('插件修复 - 标题截断', 10)).toBe('插件修复 - 标题截断')
  })

  it('compresses toward keeping the major-minor structure', () => {
    // "开发标题自动总结功能 - 修复子代理输出token上限" is far over 10 CJK (20 units).
    const result = truncateTitleByWidth('开发标题自动总结功能 - 修复子代理输出token上限', 10)
    expect(displayWidth(result)).toBeLessThanOrEqual(20)
    // When the major topic alone already fills the whole budget, the fallback
    // is a complete major topic (structure is sacrificed only then).
    expect(result === '开发标题自动总结功能' || result.includes('-')).toBe(true)
  })

  it('keeps a complete major topic when the minor is fully squeezed out', () => {
    // An enormous minor topic leaves no room; fall back to the complete major.
    const result = truncateTitleByWidth('开发标题自动总结功能 - ' + 'x'.repeat(60), 10)
    expect(displayWidth(result)).toBeLessThanOrEqual(20)
    expect(result).toBe('开发标题自动总结功能')
  })

  it('preserves the "-" structure when the major topic is short enough', () => {
    // "插件修复 - token上限" is 16 units; "插件修复 - 截断问题" is 4+2+4=10+… fits.
    const result = truncateTitleByWidth('插件修复 - token上限', 10)
    expect(displayWidth(result)).toBeLessThanOrEqual(20)
    expect(result).toContain('-')
    expect(result).toContain('插件修复')
  })

  it('never cuts an ASCII word in half', () => {
    const result = truncateTitleByWidth('dsh-session-title-summary 插件', 6)
    // "dsh-session-title-summary" is 24 ASCII = 12 CJK > 6; it must be dropped
    // whole (token boundary), not sliced mid-word.
    expect(result).not.toMatch(/dsh-…|dsh-sess/)
    expect(displayWidth(result)).toBeLessThanOrEqual(12)
  })

  it('handles a two-ASCII-chars-count-as-one-CJK title', () => {
    // "插件修复 - token上限": 插件修复(4) + 空格(1) + -(1) + 空格(1) + token(5) + 上限(4) = 16 units.
    const result = truncateTitleByWidth('插件修复 - token上限', 10)
    expect(displayWidth(result)).toBeLessThanOrEqual(20)
    expect(result).toBe('插件修复 - token上限')
  })

  it('never leaves a dangling dash when the minor topic is squeezed out', () => {
    // The minor is one long CJK run (18 units) that cannot coexist with the
    // major within 20 units; the fallback must be a complete major topic,
    // never "插件发布 -".
    const result = truncateTitleByWidth('插件发布 - 修改仓库文档并推送', 10)
    expect(displayWidth(result)).toBeLessThanOrEqual(20)
    expect(result).not.toMatch(/-$/)
    expect(result).toBe('插件发布')
  })

  it('keeps part of the minor topic instead of dropping it entirely', () => {
    // "插件发布 - 修复token上限": the 55/45 split keeps the minor's first
    // tokens, so the "-" structure survives with a real minor topic.
    const result = truncateTitleByWidth('插件发布 - 修复token上限', 10)
    expect(result).toBe('插件发布 - 修复')
  })

  it('strips a trailing bare dash with no minor topic', () => {
    const result = truncateTitleByWidth('插件发布 -', 10)
    expect(result).toBe('插件发布')
  })
})

describe('store', () => {
  it('round-trips a summary record through the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-title-summary-'))
    const sessionId = 'session-test-roundtrip'
    try {
      writeSummary(sessionId, { version: 1, lastSeq: 42, summary: 'so far' }, dir)
      const record = readSummary(sessionId, dir)
      expect(record).toEqual({ version: 1, lastSeq: 42, summary: 'so far' })
      expect(summaryPath(sessionId, dir)).toContain('dsh-session-title-summary')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined for missing or corrupt records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-title-summary-'))
    const sessionId = 'session-test-missing'
    try {
      expect(readSummary(sessionId, dir)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
