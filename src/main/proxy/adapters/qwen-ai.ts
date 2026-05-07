/**
 * Qwen AI International Adapter
 * Implements chat.qwen.ai API protocol
 * Based on qwen3-reverse project
 */

import axios, { AxiosResponse } from 'axios'
import { PassThrough } from 'stream'
import { createParser } from 'eventsource-parser'
import { Account, Provider } from '../../store/types'
import { hasToolUse, parseToolUse, ToolCall } from '../promptToolUse'
import { BaseAdapterHelper } from './baseAdapter'

const QWEN_AI_BASE = 'https://chat.qwen.ai'

const BASE_HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Content-Type': 'application/json',
  source: 'web',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  Origin: 'https://chat.qwen.ai',
}

const MODEL_ALIASES: Record<string, string> = {
  qwen: 'qwen3-max',
  qwen3: 'qwen3-max',
  'qwen3.5': 'qwen3.5-plus',
  'qwen3-coder': 'qwen3-coder-plus',
  'qwen3-vl': 'qwen3-vl-235b-a22b',
  'qwen3-omni': 'qwen3-omni-flash',
  'qwen2.5': 'qwen2.5-max',
}

interface QwenAiMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface ChatCompletionRequest {
  model: string
  /** Original model name before mapping (used for feature detection like thinking mode) */
  originalModel?: string
  messages: QwenAiMessage[]
  stream?: boolean
  temperature?: number
  enable_thinking?: boolean
  thinking_budget?: number
  chatId?: string
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function timestamp(): number {
  return Date.now()
}

export class QwenAiAdapter {
  private provider: Provider
  private account: Account
  private helper: BaseAdapterHelper
  private axiosInstance = axios.create({
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
    this.helper = new BaseAdapterHelper(account, provider, 'qwen-ai')
  }

  private getToken(): string {
    const credentials = this.account.credentials
    return credentials.token || credentials.accessToken || credentials.apiKey || ''
  }

  private getCookies(): string {
    const credentials = this.account.credentials
    return credentials.cookies || credentials.cookie || ''
  }

  private getHeaders(chatId?: string): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.helper.generateDynamicHeaders(BASE_HEADERS),
      Authorization: `Bearer ${this.getToken()}`,
      'X-Request-Id': uuid(),
    }

    if (chatId) {
      headers['Referer'] = `https://chat.qwen.ai/c/${chatId}`
    }

    const cookies = this.getCookies()
    if (cookies) {
      headers['Cookie'] = cookies
    } else {
      console.warn('[QwenAI] Warning: No cookies provided. This may cause Bad_Request error.')
      console.warn('[QwenAI] Required cookies: cnaui, aui, sca, xlly_s, cna, token, _bl_uid, x-ap')
    }

    return headers
  }

  mapModel(openaiModel: string): string {
    let model = openaiModel
    let forceThinking: boolean | undefined
    
    if (model.endsWith('-thinking')) {
      forceThinking = true
      model = model.slice(0, -9)
    } else if (model.endsWith('-fast')) {
      forceThinking = false
      model = model.slice(0, -5)
    }
    
    ;(this as any)._forceThinking = forceThinking
    
    const lowerModel = model.toLowerCase()
    
    if (MODEL_ALIASES[lowerModel]) {
      return MODEL_ALIASES[lowerModel]
    }
    
    if (this.provider.modelMappings) {
      for (const [key, value] of Object.entries(this.provider.modelMappings)) {
        if (key.toLowerCase() === lowerModel) {
          return value
        }
      }
    }
    
    return model
  }

  async createChat(modelId: string, title: string = 'New Chat'): Promise<string> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/new`
    const payload = {
      title,
      models: [modelId],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: Date.now(),
      project_id: '',
    }

    try {
      const response = await this.axiosInstance.post(url, payload, {
        headers: this.getHeaders(),
      })

      console.log('[QwenAI] Create chat response:', JSON.stringify(response.data, null, 2))

      if (response.data?.data?.id) {
        console.log('[QwenAI] Created chat:', response.data.data.id)
        return response.data.data.id
      }

      throw new Error('Failed to create chat: no chat ID returned')
    } catch (error) {
      console.error('[QwenAI] Failed to create chat:', error)
      throw error
    }
  }

  async deleteChat(chatId: string): Promise<boolean> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/${chatId}`

    try {
      const response = await this.axiosInstance.delete(url, {
        headers: this.getHeaders(),
      })

      if (response.data?.success) {
        console.log('[QwenAI] Deleted chat:', chatId)
        return true
      }

      console.warn('[QwenAI] Failed to delete chat:', response.data)
      return false
    } catch (error) {
      console.error('[QwenAI] Failed to delete chat:', error)
      return false
    }
  }

  /**
   * Delete all chats for the current account
   * @returns Promise<boolean> - true if deletion was successful
   */
  async deleteAllChats(): Promise<boolean> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/`

    try {
      console.log('[QwenAI] Deleting all chats for account')
      
      const response = await this.axiosInstance.delete(url, {
        headers: this.getHeaders(),
      })

      if (response.data?.success) {
        console.log('[QwenAI] All chats deleted successfully')
        return true
      }

      console.warn('[QwenAI] Failed to delete all chats:', response.data)
      return false
    } catch (error) {
      console.error('[QwenAI] Failed to delete all chats:', error)
      return false
    }
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{
    response: AxiosResponse
    chatId: string
    parentId: string | null
  }> {
    const token = this.getToken()
    if (!token) {
      throw new Error('Qwen AI token not configured, please add token in account settings')
    }

    const modelId = this.mapModel(request.model)
    
    // Get forced thinking mode setting from originalModel (preserves user's intent before mapping)
    // If originalModel exists, use it for thinking detection; otherwise fall back to request.model
    const modelForThinking = request.originalModel || request.model
    const modelLower = modelForThinking.toLowerCase()
    let forceThinking: boolean | undefined
    if (modelForThinking.endsWith('-thinking')) {
      forceThinking = true
    } else if (modelForThinking.endsWith('-fast')) {
      forceThinking = false
    } else if (modelLower.includes('think') || modelLower.includes('r1')) {
      // Auto-enable thinking based on model name keywords (e.g. "Qwen3.5-Plus-AI-Think-Search")
      forceThinking = true
      console.log('[QwenAI] Thinking mode enabled (from model name keyword)')
    } else {
      // Use the forceThinking from mapModel if no originalModel-specific detection
      forceThinking = (this as any)._forceThinking
    }

    // Always create a new chat (single-turn mode only)
    const chatId = await this.createChat(modelId, 'OpenAI_API_Chat')
    console.log('[QwenAI] Created new chat:', chatId)

    const messages = request.messages
    
    // Extract system message and user message
    let systemContent = ''
    let userContent = ''
    
    // Single-turn mode: extract all messages
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemContent += (systemContent ? '\n\n' : '') + msg.content
      } else if (msg.role === 'user') {
        userContent = msg.content
      }
    }
    
    // If system prompt exists, prepend it to user content
    if (systemContent) {
      userContent = `${systemContent}\n\nUser: ${userContent}`
    }

    const fid = uuid()
    const childId = uuid()
    const ts = Math.floor(Date.now() / 1000)

    // Default to disable thinking mode to avoid automatic reasoning trigger
    // Users can control thinking via:
    // 1. Model name suffix: -thinking (force thinking), -fast (force fast mode)
    // 2. enable_thinking parameter for explicit control
    // 3. If neither is specified, thinking mode is disabled by default (fast mode)
    const shouldEnableThinking = forceThinking !== undefined 
      ? forceThinking 
      : request.enable_thinking === true
    
    const featureConfig: Record<string, any> = {
      thinking_enabled: shouldEnableThinking,
      output_schema: 'phase',
      research_mode: 'normal',
      auto_thinking: shouldEnableThinking,
      thinking_format: 'summary',
      auto_search: false, // Default to disable auto search
    }

    if (request.thinking_budget) {
      featureConfig.thinking_budget = request.thinking_budget
    }

    const payload = {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'normal',
      model: modelId,
      parent_id: null,
      messages: [
        {
          fid,
          parentId: null,
          childrenIds: [childId],
          role: 'user',
          content: userContent,
          user_action: 'chat',
          files: [],
          timestamp: ts,
          models: [modelId],
          chat_type: 't2t',
          feature_config: featureConfig,
          extra: { meta: { subChatType: 't2t' } },
          sub_chat_type: 't2t',
          parent_id: null,
        },
      ],
      timestamp: ts + 1,
    }

    const url = `${QWEN_AI_BASE}/api/v2/chat/completions?chat_id=${chatId}`

    console.log('[QwenAI] Sending request to /api/v2/chat/completions...')
    console.log('[QwenAI] Request URL:', url)
    console.log('[QwenAI] Request payload:', JSON.stringify(payload, null, 2))
    console.log('[QwenAI] Request headers:', JSON.stringify(this.getHeaders(chatId), null, 2))

    // Wait for rate limit before making request
    await this.helper.waitForRateLimit()

    const response = await this.axiosInstance.post(url, payload, {
      headers: {
        ...this.getHeaders(chatId),
        'x-accel-buffering': 'no',
      },
      responseType: 'stream',
      timeout: 120000,
    })

    console.log('[QwenAI] Response status:', response.status)
    console.log('[QwenAI] Response headers:', JSON.stringify(response.headers, null, 2))

    // Store cookies from response headers if available
    const setCookieHeader = response.headers?.['set-cookie']
    if (setCookieHeader) {
      this.helper.storeCookies(setCookieHeader)
    }

    return {
      response,
      chatId,
      parentId: null,
    }
  }

  static isQwenAiProvider(provider: Provider): boolean {
    return provider.id === 'qwen-ai' || provider.apiEndpoint.includes('chat.qwen.ai')
  }
}

export class QwenAiStreamHandler {
  private chatId: string = ''
  private model: string
  private created: number
  private onEnd?: (chatId: string) => void
  private responseId: string = ''
  private content: string = ''
  private toolCallsSent: boolean = false

  constructor(model: string, onEnd?: (chatId: string) => void) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
  }

  setChatId(chatId: string) {
    this.chatId = chatId
  }

  private sendToolCalls(transStream: PassThrough): void {
    if (this.toolCallsSent) return
    
    const toolCalls = parseToolUse(this.content)
    if (toolCalls && toolCalls.length > 0) {
      this.toolCallsSent = true
      
      // Send tool_calls delta
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        transStream.write(
          `data: ${JSON.stringify({
            id: this.responseId || this.chatId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: i,
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  },
                }],
              },
              finish_reason: null,
            }],
            created: this.created,
          })}\n\n`
        )
      }
      
      // Send finish with tool_calls
      transStream.write(
        `data: ${JSON.stringify({
          id: this.responseId || this.chatId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: this.created,
        })}\n\n`
      )
      transStream.end('data: [DONE]\n\n')
      if (this.onEnd && this.chatId) {
        this.onEnd(this.chatId)
      }
    }
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const transStream = new PassThrough()

    console.log('[QwenAI] Starting stream handler...')

    let reasoningText = ''
    let hasSentReasoning = false
    let summaryText = ''
    let initialChunkSent = false

    const sendInitialChunk = () => {
      if (!initialChunkSent) {
        const initialChunk = `data: ${JSON.stringify({
          id: '',
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          created: this.created,
        })}\n\n`
        transStream.write(initialChunk)
        initialChunkSent = true
        console.log('[QwenAI] Initial chunk written')
      }
    }

    const parser = createParser({
      onEvent: (event: any) => {
        try {
          console.log('[QwenAI] Parsed event:', event.event, 'data:', event.data?.substring(0, 200))
          
          if (event.data === '[DONE]') {
            console.log('[QwenAI] Received [DONE] signal')
            return
          }

          const data = JSON.parse(event.data)
          console.log('[QwenAI] Parsed JSON data keys:', Object.keys(data))

          if (data['response.created']?.response_id) {
            this.responseId = data['response.created'].response_id
            console.log('[QwenAI] Got response_id:', this.responseId)
          }

          if (data.choices && data.choices.length > 0) {
            const choice = data.choices[0]
            const delta = choice.delta || {}
            const phase = delta.phase
            const status = delta.status
            const content = delta.content || ''

            console.log('[QwenAI] Phase:', phase, 'Status:', status, 'Content:', content.substring(0, 50))

            if (phase === 'think') {
              if (status !== 'finished') {
                // Stream thinking content as reasoning_content in real-time
                reasoningText += content
                if (!hasSentReasoning) {
                  transStream.write(
                    `data: ${JSON.stringify({
                      id: this.responseId || this.chatId,
                      model: this.model,
                      object: 'chat.completion.chunk',
                      choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '' }, finish_reason: null }],
                      created: this.created,
                    })}\n\n`
                  )
                  hasSentReasoning = true
                  console.log('[QwenAI] Sent reasoning role chunk')
                }
                if (content) {
                  transStream.write(
                    `data: ${JSON.stringify({
                      id: this.responseId || this.chatId,
                      model: this.model,
                      object: 'chat.completion.chunk',
                      choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }],
                      created: this.created,
                    })}\n\n`
                  )
                }
              }
              // When status === 'finished', the think phase is done
            } else if (phase === 'thinking_summary') {
              const extra = delta.extra || {}
              console.log('[QwenAI] thinking_summary extra:', JSON.stringify(extra).substring(0, 300))
              if (extra.summary_thought?.content) {
                const newSummary = extra.summary_thought.content.join('\n')
                if (newSummary && newSummary.length > summaryText.length) {
                  // Send only the incremental diff as reasoning_content
                  const diff = newSummary.substring(summaryText.length)
                  if (diff) {
                    if (!hasSentReasoning) {
                      transStream.write(
                        `data: ${JSON.stringify({
                          id: this.responseId || this.chatId,
                          model: this.model,
                          object: 'chat.completion.chunk',
                          choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '' }, finish_reason: null }],
                          created: this.created,
                        })}\n\n`
                      )
                      hasSentReasoning = true
                    }
                    transStream.write(
                      `data: ${JSON.stringify({
                        id: this.responseId || this.chatId,
                        model: this.model,
                        object: 'chat.completion.chunk',
                        choices: [{ index: 0, delta: { reasoning_content: diff }, finish_reason: null }],
                        created: this.created,
                      })}\n\n`
                    )
                  }
                  summaryText = newSummary
                  console.log('[QwenAI] Updated summaryText, length:', summaryText.length)
                }
              }
            } else if (phase === 'answer') {
              if (!initialChunkSent) {
                sendInitialChunk()
              }
              console.log('[QwenAI] Entering answer branch, content:', content)
              
              // Accumulate content for tool call detection
              this.content += content
              
              if (content) {
                console.log('[QwenAI] Sending content chunk:', content)
                const chunk = {
                  id: this.responseId || this.chatId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { content }, finish_reason: null }],
                  created: this.created,
                }
                transStream.write(`data: ${JSON.stringify(chunk)}\n\n`)
                console.log('[QwenAI] Content chunk written')
              }
            } else if (phase === null && content) {
              if (!initialChunkSent) {
                sendInitialChunk()
              }
              // Accumulate content for tool call detection
              this.content += content
              
              const chunk = {
                id: this.responseId || this.chatId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { content }, finish_reason: null }],
                created: this.created,
              }
              transStream.write(`data: ${JSON.stringify(chunk)}\n\n`)
            }

            if (status === 'finished' && (phase === 'answer' || phase === null)) {
              // Check for tool calls before sending stop
              if (hasToolUse(this.content)) {
                console.log('[QwenAI] Found tool_use in stream, sending tool_calls')
                this.sendToolCalls(transStream)
                return
              }
              
              const finishReason = delta.finish_reason || 'stop'
              const finalChunk = {
                id: this.responseId || this.chatId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                created: this.created,
              }
              transStream.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
              transStream.end('data: [DONE]\n\n')

              if (this.onEnd && this.chatId) {
                this.onEnd(this.chatId)
              }
            }
          }
        } catch (err) {
          console.error('[QwenAI] Stream parse error:', err)
        }
      },
    })

    stream.on('data', (buffer: Buffer) => {
      const text = buffer.toString()
      console.log('[QwenAI] Raw stream data:', text.substring(0, 500))
      parser.feed(text)
    })
    stream.once('error', (err: Error) => {
      console.error('[QwenAI] Stream error:', err)
      transStream.end('data: [DONE]\n\n')
    })
    stream.once('close', () => {
      console.log('[QwenAI] Stream closed')
      transStream.end('data: [DONE]\n\n')
    })

    return transStream
  }

  async handleNonStream(stream: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = {
        id: '',
        model: this.model,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '', reasoning_content: '' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created: this.created,
      }

      let reasoningText = ''
      let summaryText = ''
      let resolved = false

      const resolveOnce = (value: any) => {
        if (!resolved) {
          resolved = true
          resolve(value)
        }
      }

      const rejectOnce = (reason: any) => {
        if (!resolved) {
          resolved = true
          reject(reason)
        }
      }

      const parser = createParser({
        onEvent: (event: any) => {
          try {
            if (event.data === '[DONE]') return

            const parsed = JSON.parse(event.data)

            if (parsed['response.created']?.response_id) {
              this.responseId = parsed['response.created'].response_id
              data.id = this.responseId
            }

            if (parsed.choices && parsed.choices.length > 0) {
              const delta = parsed.choices[0].delta || {}
              const phase = delta.phase
              const status = delta.status
              const content = delta.content || ''

              if (phase === 'think' && status !== 'finished') {
                reasoningText += content
              } else if (phase === 'thinking_summary') {
                // Handle thinking_summary phase - extract summary content
                const extra = delta.extra || {}
                if (extra.summary_thought?.content) {
                  const newSummary = extra.summary_thought.content.join('\n')
                  if (newSummary && newSummary.length > summaryText.length) {
                    summaryText = newSummary
                  }
                }
              } else if (phase === 'answer') {
                if (content) {
                  data.choices[0].message.content += content
                }
                if (status === 'finished') {
                  // Use reasoningText or summaryText for reasoning_content
                  const finalReasoning = reasoningText || summaryText
                  if (finalReasoning) {
                    data.choices[0].message.reasoning_content = finalReasoning
                  }

                  if (this.onEnd && this.chatId) {
                    this.onEnd(this.chatId)
                  }

                  resolveOnce(data)
                }
              } else if (phase === null && content) {
                data.choices[0].message.content += content
              }
            }
          } catch (err) {
            console.error('[QwenAI] Non-stream parse error:', err)
            rejectOnce(err)
          }
        },
      })

      stream.on('data', (buffer: Buffer) => parser.feed(buffer.toString()))
      stream.once('error', (err: Error) => {
        console.error('[QwenAI] Non-stream error:', err)
        rejectOnce(err)
      })
      stream.once('close', () => {
        // Use reasoningText or summaryText for reasoning_content
        const finalReasoning = reasoningText || summaryText
        if (finalReasoning) {
          data.choices[0].message.reasoning_content = finalReasoning
        }
        resolveOnce(data)
      })
    })
  }

  getChatId(): string {
    return this.chatId
  }

  getResponseId(): string {
    return this.responseId
  }
}

export const qwenAiAdapter = {
  QwenAiAdapter,
  QwenAiStreamHandler,
}
