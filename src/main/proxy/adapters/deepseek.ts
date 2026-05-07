/**
 * DeepSeek Adapter
 * Implements DeepSeek web API protocol
 * 
 * NOTE: Tool prompt injection is handled by Forwarder.transformRequestForPromptToolUse()
 * This adapter only handles message format conversion and API communication
 */

import axios, { AxiosResponse } from 'axios'
import { getDeepSeekHash } from '../../lib/challenge'
import type { Account, Provider } from '../../store/types'
import { resolveDeepSeekChatOptions } from './providerModelOptions'
import { BaseAdapterHelper } from './baseAdapter'

const DEEPSEEK_API_BASE = 'https://chat.deepseek.com/api'

const BASE_HEADERS = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'X-Client-Locale': 'zh-CN',
  'X-Client-Platform': 'web',
  'x-Client-Timezone-Offset': '28800',
}

interface TokenInfo {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface ChallengeResponse {
  algorithm: string
  challenge: string
  salt: string
  difficulty: number
  expire_at: number
  signature: string
}

interface DeepSeekMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest {
  model: string
  messages: DeepSeekMessage[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high'
  tools?: any[]
  tool_choice?: any
}

const tokenCache = new Map<string, TokenInfo>()
const sessionCache = new Map<string, { sessionId: string; createdAt: number }>()

function generateRandomString(length: number, charset: string = 'alphanumeric'): string {
  const sets = {
    numeric: '0123456789',
    alphabetic: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    alphanumeric: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    hex: '0123456789abcdef',
  }
  const chars = sets[charset as keyof typeof sets] || sets.alphanumeric
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

function buildDynamicHeaders(helper: BaseAdapterHelper): Record<string, string> {
  return helper.generateDynamicHeaders({
    ...BASE_HEADERS,
    Origin: 'https://chat.deepseek.com',
    Referer: 'https://chat.deepseek.com/',
  })
}

export class DeepSeekAdapter {
  private provider: Provider
  private account: Account
  private token: string
  private helper: BaseAdapterHelper

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
    this.token = account.credentials.token || account.credentials.apiKey || account.credentials.refreshToken || ''
    this.helper = new BaseAdapterHelper(account, provider, 'deepseek')
  }

  private async acquireToken(): Promise<string> {
    if (!this.token) {
      throw new Error('DeepSeek Token not configured, please add Token in account settings')
    }

    const cached = tokenCache.get(this.token)
    if (cached && cached.expiresAt > unixTimestamp()) {
      return cached.accessToken
    }

    console.log('[DeepSeek] Acquiring token...')

    const headers = buildDynamicHeaders(this.helper)
    const result = await axios.get(`${DEEPSEEK_API_BASE}/v0/users/current`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...headers,
      },
      timeout: 15000,
      validateStatus: () => true,
    })

    console.log('[DeepSeek] Token response status:', result.status)

    if (result.status === 401 || result.status === 403) {
      throw new Error(`Token invalid or expired, please get a new Token`)
    }

    if (result.status !== 200) {
      throw new Error(`Failed to acquire token: HTTP ${result.status}`)
    }

    const bizData = result.data?.data?.biz_data || result.data?.biz_data
    if (!bizData?.token) {
      const errorMsg = result.data?.msg || result.data?.data?.biz_msg || 'Unknown error'
      console.log('[DeepSeek] Token response data:', JSON.stringify(result.data, null, 2))
      throw new Error(`Failed to acquire token: ${errorMsg}`)
    }

    const accessToken = bizData.token
    // Jitter: 55-65 minutes instead of exactly 60
    const jitterMinutes = 55 + Math.random() * 10
    tokenCache.set(this.token, {
      accessToken,
      refreshToken: this.token,
      expiresAt: unixTimestamp() + Math.floor(jitterMinutes * 60),
    })

    // Store any cookies from response
    const setCookie = result.headers?.['set-cookie']
    if (setCookie) {
      this.helper.storeCookies(setCookie)
    }

    console.log('[DeepSeek] Token acquired successfully')
    return accessToken
  }

  private async createSession(): Promise<string> {
    const cacheKey = this.account.id
    const cached = sessionCache.get(cacheKey)
    if (cached && Date.now() - cached.createdAt < 300000) {
      return cached.sessionId
    }

    // Check for reusable session
    const reusableSession = this.helper.getReusableSession()
    if (reusableSession) {
      console.log('[DeepSeek] Reusing existing session:', reusableSession)
      sessionCache.set(cacheKey, { sessionId: reusableSession, createdAt: Date.now() })
      return reusableSession
    }

    // Wait for rate limit
    await this.helper.waitForRateLimit()

    const token = await this.acquireToken()
    const headers = buildDynamicHeaders(this.helper)
    const fingerprint = this.helper.getDeviceFingerprint()
    const storedCookies = this.helper.getCookies('deepseek.com')

    const result = await axios.post(
      `${DEEPSEEK_API_BASE}/v0/chat_session/create`,
      {},
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...headers,
          Cookie: storedCookies || `device_id=${fingerprint.deviceId}`,
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    // Store cookies from response
    const setCookie = result.headers?.['set-cookie']
    if (setCookie) {
      this.helper.storeCookies(setCookie)
    }

    console.log('[DeepSeek] Create session response:', JSON.stringify(result.data, null, 2))

    const bizData = result.data?.data?.biz_data || result.data?.biz_data
    if (result.status !== 200 || !bizData?.chat_session?.id) {
      throw new Error(`Failed to create session: ${result.data?.msg || result.data?.data?.biz_msg || result.status}`)
    }

    const sessionId = bizData?.chat_session?.id
    sessionCache.set(cacheKey, { sessionId, createdAt: Date.now() })

    // Store session for reuse
    this.helper.storeSession(sessionId, 300000)

    return sessionId
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      const token = await this.acquireToken()
      const headers = buildDynamicHeaders(this.helper)
      const result = await axios.post(
        `${DEEPSEEK_API_BASE}/v0/chat_session/delete`,
        { chat_session_id: sessionId },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...headers,
          },
          timeout: 15000,
          validateStatus: () => true,
        }
      )

      console.log('[DeepSeek] Delete session response:', JSON.stringify(result.data, null, 2))

      const success = result.status === 200 && result.data?.code === 0
      if (success) {
        // Clear cache
        const cacheKey = this.account.id
        sessionCache.delete(cacheKey)
        console.log('[DeepSeek] Session deleted:', sessionId)
      }
      return success
    } catch (error) {
      console.error('[DeepSeek] Failed to delete session:', error)
      return false
    }
  }

  private async getChallenge(targetPath: string): Promise<ChallengeResponse> {
    const token = await this.acquireToken()
    const headers = buildDynamicHeaders(this.helper)
    const result = await axios.post(
      `${DEEPSEEK_API_BASE}/v0/chat/create_pow_challenge`,
      { target_path: targetPath },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...headers,
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    // Response structure: { code: 0, data: { biz_code: 0, biz_data: { challenge: {...} } } }
    const bizData = result.data?.data?.biz_data || result.data?.biz_data
    if (result.status !== 200 || !bizData?.challenge) {
      throw new Error(`Failed to get challenge: ${result.data?.msg || result.data?.data?.biz_msg || result.status}`)
    }

    return bizData.challenge
  }

  private async calculateChallengeAnswer(challenge: ChallengeResponse): Promise<string> {
    const { algorithm, challenge: challengeStr, salt, difficulty, expire_at, signature } = challenge
    
    if (algorithm !== 'DeepSeekHashV1') {
      throw new Error(`Unsupported algorithm: ${algorithm}`)
    }
    
    console.log('[DeepSeek] Challenge parameters:', { difficulty })
    
    const deepSeekHash = await getDeepSeekHash()
    const answer = deepSeekHash.calculateHash(algorithm, challengeStr, salt, difficulty, expire_at)
    
    if (answer === undefined) {
      throw new Error('Challenge calculation failed')
    }
    
    console.log('[DeepSeek] Challenge answer found:', answer)

    return Buffer.from(JSON.stringify({
      algorithm,
      challenge: challengeStr,
      salt,
      answer,
      signature,
      target_path: '/api/v0/chat/completion',
    })).toString('base64')
  }

  private messagesToPrompt(messages: DeepSeekMessage[], isMultiTurn: boolean = false): string {
    const processedMessages = messages.map(message => {
      let text: string

      // Handle tool calls in assistant message
      if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
        const toolCallsText = message.tool_calls.map(tc => {
          return `<tool_calling>
<name>${tc.function.name}</name>
<arguments>${tc.function.arguments}</arguments>
</tool_calling>`
        }).join('\n')
        text = toolCallsText
      }
      // Handle tool response message
      else if (message.role === 'tool' && message.tool_call_id) {
        text = `<tool_response tool_call_id="${message.tool_call_id}">
${message.content || ''}
</tool_response>`
      }
      else if (Array.isArray(message.content)) {
        const texts = message.content
          .filter((item: any) => item.type === 'text')
          .map((item: any) => item.text)
        text = texts.join('\n')
      } else {
        text = String(message.content || '')
      }
      return { role: message.role, text }
    })

    if (processedMessages.length === 0) return ''

    // For multi-turn mode, only send the last user message
    if (isMultiTurn) {
      let lastUserIdx = -1
      for (let i = processedMessages.length - 1; i >= 0; i--) {
        if (processedMessages[i].role === 'user') {
          lastUserIdx = i
          break
        }
      }
      
      if (lastUserIdx !== -1) {
        const lastUserMsg = processedMessages[lastUserIdx]
        let text = lastUserMsg.text
        for (let i = lastUserIdx + 1; i < processedMessages.length; i++) {
          if (processedMessages[i].role === 'tool') {
            text += `\n\n${processedMessages[i].text}`
          }
        }
        return `<｜User｜>${text}`
      }
    }

    const mergedBlocks: { role: string; text: string }[] = []
    let currentBlock = { ...processedMessages[0] }

    for (let i = 1; i < processedMessages.length; i++) {
      const msg = processedMessages[i]
      if (msg.role === currentBlock.role) {
        currentBlock.text += `\n\n${msg.text}`
      } else {
        mergedBlocks.push(currentBlock)
        currentBlock = { ...msg }
      }
    }
    mergedBlocks.push(currentBlock)

    return mergedBlocks
      .map((block, index) => {
        if (block.role === 'assistant') {
          return `<｜Assistant｜>${block.text}<｜end of sentence｜>`
        }
        if (block.role === 'user' || block.role === 'system') {
          return index > 0 ? `<｜User｜>${block.text}` : block.text
        }
        if (block.role === 'tool') {
          return `<｜User｜>${block.text}`
        }
        return block.text
      })
      .join('')
      .replace(/!\[.+\]\(.+\)/g, '')
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; sessionId: string }> {
    const token = await this.acquireToken()

    const sessionId = await this.createSession()
    console.log('[DeepSeek] Created new session:', sessionId)

    const challenge = await this.getChallenge('/api/v0/chat/completion')
    const challengeAnswer = await this.calculateChallengeAnswer(challenge)

    const messages = [...request.messages]

    let prompt = this.messagesToPrompt(messages, false)

    const { modelType, searchEnabled, thinkingEnabled } = resolveDeepSeekChatOptions(request, prompt)

    if (request.web_search || request.model.toLowerCase().includes('search')) {
      console.log('[DeepSeek] Web search enabled')
    }

    if (request.reasoning_effort || thinkingEnabled) {
      console.log('[DeepSeek] Reasoning mode enabled, effort:', request.reasoning_effort)
    }

    // Wait for rate limit before making the main request
    await this.helper.waitForRateLimit()
    await this.helper.addJitter(500, 1500)

    const headers = buildDynamicHeaders(this.helper)
    const fingerprint = this.helper.getDeviceFingerprint()
    const storedCookies = this.helper.getCookies('deepseek.com')

    const response = await axios.post(
      `${DEEPSEEK_API_BASE}/v0/chat/completion`,
      {
        chat_session_id: sessionId,
        parent_message_id: null,
        prompt,
        model_type: modelType,
        ref_file_ids: [],
        search_enabled: searchEnabled,
        thinking_enabled: thinkingEnabled,
        preempt: false,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...headers,
          Cookie: storedCookies || `device_id=${fingerprint.deviceId}`,
          'X-Ds-Pow-Response': challengeAnswer,
        },
        timeout: 120000,
        validateStatus: () => true,
        responseType: 'stream',
      }
    )

    // Store cookies from response
    const setCookie = response.headers?.['set-cookie']
    if (setCookie) {
      this.helper.storeCookies(setCookie)
    }

    return { response, sessionId }
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      const token = await this.acquireToken()
      const headers = buildDynamicHeaders(this.helper)
      const result = await axios.post(
        `${DEEPSEEK_API_BASE}/v0/chat_session/delete_all`,
        {},
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...headers,
          },
          timeout: 30000,
          validateStatus: () => true,
        }
      )

      console.log('[DeepSeek] Delete all chats response:', JSON.stringify(result.data, null, 2))

      const success = result.status === 200 && result.data?.code === 0
      if (success) {
        sessionCache.clear()
        console.log('[DeepSeek] All chats deleted')
      }
      return success
    } catch (error) {
      console.error('[DeepSeek] Failed to delete all chats:', error)
      return false
    }
  }

  static isDeepSeekProvider(provider: Provider): boolean {
    return provider.id === 'deepseek' || provider.apiEndpoint.includes('deepseek.com')
  }

  /**
   * Clear session cache for a specific account
   * This should be called when a session is deleted externally (e.g., from web)
   */
  static clearSessionCache(accountId: string): void {
    sessionCache.delete(accountId)
    console.log('[DeepSeek] Cleared session cache for account:', accountId)
  }
}

export const deepSeekAdapter = {
  DeepSeekAdapter,
}
