/**
 * Boundary sanitizer for provider-visible tool-call pairing. Verifies that a
 * derived history never reaches an LLM adapter with a dangling or malformed
 * tool-call (empty id/name, non-JSON arguments, or no matching result).
 */

import { describe, expect, it, vi } from 'vitest'
import { CallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { sanitizeToolPairing } from '../src/agent.ts'

function toolCall(id: string, name = 'bash', args = '{}'): ContentBlock {
  return { type: 'tool-call', id: CallId(id), name, arguments: args }
}

function assistant(content: ContentBlock[]): Message {
  return createAssistantMessage({
    content,
    source: { provider: 'mock', model: 'mock' },
  })
}

function toolResult(callId: string, text = 'ok'): Message {
  return createToolResultMessage({
    callId: CallId(callId),
    content: [{ type: 'text', text }],
    isError: false,
  })
}

/** The tool-call ids still present on an assistant message after sanitizing. */
function survivingCallIds(messages: readonly Message[]): string[] {
  return messages.flatMap(message =>
    message.content.filter(block => block.type === 'tool-call').map(block => block.id),
  )
}

describe('sanitizeToolPairing', () => {
  it('passes through a balanced call/result pair unchanged', () => {
    const messages = [
      assistant([toolCall('call-1', 'bash', '{"cmd":"ls"}')]),
      toolResult('call-1'),
    ]
    const out = sanitizeToolPairing(messages)
    expect(out).toHaveLength(2)
    expect(survivingCallIds(out)).toEqual(['call-1'])
    // No rewrite: the same message objects are reused.
    expect(out[0]).toBe(messages[0])
    expect(out[1]).toBe(messages[1])
  })

  it('strips an orphaned tool-call with no matching result', () => {
    const out = sanitizeToolPairing([
      assistant([toolCall('orphan', 'bash', '{}')]),
    ])
    expect(survivingCallIds(out)).toEqual([])
  })

  it('keeps an orphaned tool-result (providers tolerate extra tool messages)', () => {
    const result = toolResult('never-called')
    const out = sanitizeToolPairing([result])
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(result)
  })

  it('strips a tool-call with an empty id even when a result matches', () => {
    const out = sanitizeToolPairing([
      assistant([toolCall('', 'bash', '{}')]),
      toolResult(''),
    ])
    expect(survivingCallIds(out)).toEqual([])
  })

  it('strips a tool-call with an empty name even when a result matches', () => {
    const out = sanitizeToolPairing([
      assistant([toolCall('call-1', '', '{}')]),
      toolResult('call-1'),
    ])
    expect(survivingCallIds(out)).toEqual([])
  })

  it('strips a tool-call with non-JSON arguments even when a result matches', () => {
    const out = sanitizeToolPairing([
      assistant([toolCall('call-1', 'bash', '{"cmd":')]),
      toolResult('call-1'),
    ])
    expect(survivingCallIds(out)).toEqual([])
  })

  it('keeps a no-arg call whose arguments string is blank', () => {
    const out = sanitizeToolPairing([
      assistant([toolCall('call-1', 'ping', '')]),
      toolResult('call-1'),
    ])
    expect(survivingCallIds(out)).toEqual(['call-1'])
  })

  it('strips only the unusable calls in a parallel batch', () => {
    const out = sanitizeToolPairing([
      assistant([
        toolCall('good', 'bash', '{}'),
        toolCall('orphan', 'bash', '{}'),
        toolCall('bad-args', 'bash', 'oops'),
      ]),
      toolResult('good'),
      toolResult('bad-args'),
    ])
    expect(survivingCallIds(out)).toEqual(['good'])
  })

  it('leaves non-assistant messages untouched and does not rewrite when clean', () => {
    const messages = [
      toolResult('call-1'),
      assistant([toolCall('call-1', 'bash', '{}')]),
    ]
    const out = sanitizeToolPairing(messages)
    expect(out.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(survivingCallIds(out)).toEqual(['call-1'])
  })

  it('does not mutate the input messages when a rewrite occurs', () => {
    const input = [
      assistant([toolCall('orphan', 'bash', '{}')]),
    ]
    const before = input[0]!.content.length
    sanitizeToolPairing(input)
    expect(input[0]!.content).toHaveLength(before)
  })

  it('warns once per assistant message that had unusable calls', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      sanitizeToolPairing([
        assistant([toolCall('orphan', 'bash', '{}')]),
      ])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]![0]).toContain('stripping 1 unusable tool-call(s)')
    } finally {
      warn.mockRestore()
    }
  })
})
