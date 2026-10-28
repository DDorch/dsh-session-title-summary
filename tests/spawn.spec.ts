/**
 * Unit tests for the dual-path spawn helper (`spawnFoldSubagent`): the
 * dsh-subagent 0.2.1+ `startActivation` shape, the 0.1.x legacy `start`
 * shape, and the neither-API degradation. No LLM, no cordis runtime.
 */

import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { spawnFoldSubagent } from '../src/index.ts'

const agent = { id: 'session-parent' } as unknown as Agent
const signal = () => new AbortController().signal
const fakeResult = { output: [] as readonly [] }

describe('spawnFoldSubagent', () => {
  it('calls startActivation (dsh-subagent 0.2.1+) with the activation spec shape', async () => {
    const seen: unknown[] = []
    const service = {
      startActivation: (spec: unknown) => {
        seen.push(spec)
        return Promise.resolve({ result: Promise.resolve(fakeResult) })
      },
    }
    const handle = await spawnFoldSubagent(service, agent, 'PROMPT', signal())
    expect(handle.result).toBeInstanceOf(Promise)
    await expect(handle.result).resolves.toBe(fakeResult)

    expect(seen).toHaveLength(1)
    const spec = seen[0] as Record<string, unknown>
    expect(spec.provider).toBe('spawn')
    expect(spec.label).toBe('session-title-summary')
    expect(spec.delivery).toBe('caller')
    expect(spec.signal).toBeDefined()
    const request = spec.request as Record<string, unknown>
    expect(request.prompt).toEqual([{ type: 'text', text: 'PROMPT' }])
    expect(request.parent).toBe(agent)
    expect(request.agentOptions).toEqual({ maxTokens: 8192 })
    expect(request.outputSchema).toMatchObject({
      type: 'object',
      required: ['summary', 'title'],
      additionalProperties: false,
    })
    // 0.2.1 spec: label and signal live at the activation level, not in request.
    expect(request.label).toBeUndefined()
    expect(request.signal).toBeUndefined()
  })

  it('falls back to the legacy start (dsh-subagent 0.1.x) with the flat request shape', async () => {
    const seen: Array<[string, Record<string, unknown>]> = []
    const service = {
      start: (provider: string, request: Record<string, unknown>) => {
        seen.push([provider, request])
        return Promise.resolve({ result: Promise.resolve(fakeResult) })
      },
    }
    const handle = await spawnFoldSubagent(service, agent, 'PROMPT', signal())
    await expect(handle.result).resolves.toBe(fakeResult)

    expect(seen).toHaveLength(1)
    const [provider, request] = seen[0]
    expect(provider).toBe('spawn')
    expect(request.label).toBe('session-title-summary')
    expect(request.signal).toBeDefined()
    expect(request.prompt).toEqual([{ type: 'text', text: 'PROMPT' }])
    expect(request.parent).toBe(agent)
    expect(request.agentOptions).toEqual({ maxTokens: 8192 })
    expect(request.outputSchema).toMatchObject({ required: ['summary', 'title'] })
  })

  it('prefers startActivation when both entry points exist', async () => {
    const calls: string[] = []
    const service = {
      start: () => {
        calls.push('start')
        return Promise.resolve({ result: Promise.resolve(fakeResult) })
      },
      startActivation: () => {
        calls.push('startActivation')
        return Promise.resolve({ result: Promise.resolve(fakeResult) })
      },
    }
    await spawnFoldSubagent(service, agent, 'PROMPT', signal())
    expect(calls).toEqual(['startActivation'])
  })

  it('forwards a configured route through agentOptions (real route override)', async () => {
    const seen: unknown[] = []
    const service = {
      startActivation: (spec: unknown) => {
        seen.push(spec)
        return Promise.resolve({ result: Promise.resolve(fakeResult) })
      },
    }
    await spawnFoldSubagent(
      service, agent, 'PROMPT', signal(),
      { provider: 'albert', model: 'qwen3-coder' },
    )
    const request = (seen[0] as Record<string, unknown>).request as Record<string, unknown>
    expect(request.agentOptions).toEqual({
      maxTokens: 8192,
      provider: 'albert',
      model: 'qwen3-coder',
    })
  })

  it('keeps the prompt free of route hints (the route rides on agentOptions)', async () => {
    const seen: unknown[] = []
    const service = {
      startActivation: (spec: unknown) => {
        seen.push(spec)
        return Promise.resolve({ result: Promise.resolve(fakeResult) })
      },
    }
    await spawnFoldSubagent(
      service, agent, 'SYSTEM\n\nUSER', signal(),
      { provider: 'albert', model: 'qwen3-coder' },
    )
    const request = (seen[0] as Record<string, unknown>).request as Record<string, unknown>
    expect(request.prompt).toEqual([{ type: 'text', text: 'SYSTEM\n\nUSER' }])
  })

  it('rejects with a diagnostic when the service exposes neither entry point', async () => {
    await expect(spawnFoldSubagent({}, agent, 'PROMPT', signal())).rejects.toThrow(
      /neither startActivation.*nor start/,
    )
  })
})
