/**
 * Anti-Detection Service
 * Provides dynamic fingerprints, rate limiting, cookie management, and session reuse
 * to reduce the risk of accounts being banned by providers.
 */

import { Account, Provider } from '../../store/types'

// ============ Types ============

export interface DeviceFingerprint {
  deviceId: string
  screenResolution: { width: number; height: number }
  viewportSize: { width: number; height: number }
  pixelRatio: number
  colorDepth: number
  timezone: string
  language: string
  platform: string
  userAgentBase: string
  createdAt: number
}

export interface BrowserVersion {
  chromeVersion: number
  updatedAt: number
}

export interface RateLimitState {
  tokens: number
  lastRefill: number
  maxTokens: number
  refillRate: number
}

export interface CookieEntry {
  name: string
  value: string
  domain: string
  path: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
}

export interface AccountState {
  fingerprint: DeviceFingerprint
  rateLimit: RateLimitState
  cookies: Map<string, CookieEntry>
  lastRequestTime: number
  requestCount: number
  sessionIds: Map<string, { id: string; createdAt: number; ttl: number }>
}

// ============ Constants ============

const CHROME_VERSION_MIN = 130
const CHROME_VERSION_MAX = 146
const CHROME_VERSION_UPDATE_INTERVAL = 7 * 24 * 60 * 60 * 1000

const COMMON_RESOLUTIONS = [
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1680, height: 1050 },
  { width: 1280, height: 800 },
  { width: 2560, height: 1080 },
]

const COMMON_PLATFORMS = ['Windows', 'macOS', 'Linux']
const COMMON_LANGUAGES = ['zh-CN,zh;q=0.9,en;q=0.8', 'zh-CN,zh', 'en-US,en;q=0.9', 'zh-CN,zh;q=0.9']
const COMMON_TIMEZONES = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore']

// ============ Service ============

class AntiDetectionServiceClass {
  private accountStates = new Map<string, AccountState>()
  private currentBrowserVersion: BrowserVersion

  constructor() {
    this.currentBrowserVersion = this.generateBrowserVersion()
    this.startVersionUpdater()
  }

  // ============ Browser Version ============

  private generateBrowserVersion(): BrowserVersion {
    const chromeVersion = CHROME_VERSION_MIN + Math.floor(
      Math.random() * (CHROME_VERSION_MAX - CHROME_VERSION_MIN + 1)
    )
    return { chromeVersion, updatedAt: Date.now() }
  }

  private startVersionUpdater(): void {
    setInterval(() => {
      if (Date.now() - this.currentBrowserVersion.updatedAt > CHROME_VERSION_UPDATE_INTERVAL) {
        const next = Math.min(this.currentBrowserVersion.chromeVersion + 1, 200)
        this.currentBrowserVersion = { chromeVersion: next, updatedAt: Date.now() }
        console.log(`[AntiDetection] Browser version updated to Chrome ${next}`)
      }
    }, 24 * 60 * 60 * 1000)
  }

  getCurrentBrowserVersion(): BrowserVersion {
    return { ...this.currentBrowserVersion }
  }

  // ============ Device Fingerprint ============

  private generateDeviceFingerprint(): DeviceFingerprint {
    const resolution = COMMON_RESOLUTIONS[Math.floor(Math.random() * COMMON_RESOLUTIONS.length)]
    const platform = COMMON_PLATFORMS[Math.floor(Math.random() * COMMON_PLATFORMS.length)]
    const language = COMMON_LANGUAGES[Math.floor(Math.random() * COMMON_LANGUAGES.length)]
    const timezone = COMMON_TIMEZONES[Math.floor(Math.random() * COMMON_TIMEZONES.length)]
    const pixelRatio = [1, 1.25, 1.5, 2][Math.floor(Math.random() * 4)] as number

    return {
      deviceId: this.generateUUID(),
      screenResolution: resolution,
      viewportSize: {
        width: resolution.width - Math.floor(Math.random() * 200),
        height: resolution.height - 100 + Math.floor(Math.random() * 100) - 50,
      },
      pixelRatio,
      colorDepth: [24, 30, 32][Math.floor(Math.random() * 3)],
      timezone,
      language,
      platform,
      userAgentBase: this.generateUserAgent(platform),
      createdAt: Date.now(),
    }
  }

  private generateUserAgent(platform: string): string {
    const v = this.currentBrowserVersion.chromeVersion
    const platformStr = platform === 'Windows'
      ? 'Windows NT 10.0; Win64; x64'
      : platform === 'macOS'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64'
    return `Mozilla/5.0 (${platformStr}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`
  }

  getAccountFingerprint(accountId: string): DeviceFingerprint {
    let state = this.accountStates.get(accountId)
    if (!state) {
      state = this.createAccountState(accountId)
    }
    return state.fingerprint
  }

  // ============ Rate Limiting (Token Bucket) ============

  private createRateLimitState(maxRPM: number = 60): RateLimitState {
    return {
      tokens: maxRPM,
      lastRefill: Date.now(),
      maxTokens: maxRPM,
      refillRate: maxRPM / 60,
    }
  }

  async waitForRateLimit(accountId: string, maxRPM?: number): Promise<number> {
    let state = this.accountStates.get(accountId)
    if (!state) {
      state = this.createAccountState(accountId, maxRPM)
    }

    const now = Date.now()
    const elapsed = (now - state.rateLimit.lastRefill) / 1000
    const refill = elapsed * state.rateLimit.refillRate
    state.rateLimit.tokens = Math.min(state.rateLimit.maxTokens, state.rateLimit.tokens + refill)
    state.rateLimit.lastRefill = now

    if (state.rateLimit.tokens < 1) {
      const jitter = 1000 + Math.random() * 2000
      const waitTime = Math.ceil((1 - state.rateLimit.tokens) / state.rateLimit.refillRate * 1000 + jitter)
      console.log(`[AntiDetection] Rate limit: waiting ${waitTime}ms for account ${accountId}`)
      await this.delay(waitTime)
      state.rateLimit.tokens = 0
      state.rateLimit.lastRefill = Date.now()
      return waitTime
    }

    state.rateLimit.tokens -= 1
    state.requestCount++
    state.lastRequestTime = Date.now()
    return 0
  }

  // ============ Cookie Management ============

  parseSetCookie(setCookieHeader: string | string[]): Map<string, CookieEntry> {
    const cookies = new Map<string, CookieEntry>()
    const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader]

    for (const header of headers) {
      const parts = header.split(';').map(p => p.trim())
      if (parts.length === 0) continue

      const [nameValue, ...attributes] = parts
      const eqIndex = nameValue.indexOf('=')
      if (eqIndex === -1) continue

      const name = nameValue.substring(0, eqIndex)
      const value = nameValue.substring(eqIndex + 1)

      const entry: CookieEntry = { name, value, domain: '', path: '/' }

      for (const attr of attributes) {
        const [key, val] = attr.split('=')
        const lowerKey = key.toLowerCase().trim()
        if (lowerKey === 'domain') entry.domain = val?.trim() || ''
        else if (lowerKey === 'path') entry.path = val?.trim() || '/'
        else if (lowerKey === 'expires') {
          try { entry.expires = new Date(val.trim()).getTime() } catch {}
        }
        else if (lowerKey === 'httponly') entry.httpOnly = true
        else if (lowerKey === 'secure') entry.secure = true
      }

      cookies.set(name, entry)
    }

    return cookies
  }

  storeCookies(accountId: string, cookies: Map<string, CookieEntry>): void {
    const state = this.accountStates.get(accountId)
    if (!state) return

    cookies.forEach((entry, name) => {
      if (entry.expires && entry.expires < Date.now()) {
        state.cookies.delete(name)
      } else {
        state.cookies.set(name, entry)
      }
    })
  }

  formatCookies(accountId: string, domain?: string): string {
    const state = this.accountStates.get(accountId)
    if (!state) return ''

    const now = Date.now()
    const validCookies: string[] = []

    state.cookies.forEach((entry, name) => {
      if (entry.expires && entry.expires < now) {
        state.cookies.delete(name)
        return
      }
      if (!domain || entry.domain.includes(domain) || domain.includes(entry.domain)) {
        validCookies.push(`${name}=${entry.value}`)
      }
    })

    return validCookies.join('; ')
  }

  // ============ Session Reuse ============

  storeSession(accountId: string, sessionId: string, ttl: number = 300000): void {
    const state = this.accountStates.get(accountId)
    if (!state) return
    state.sessionIds.set(sessionId, { id: sessionId, createdAt: Date.now(), ttl })
  }

  getReusableSession(accountId: string): string | null {
    const state = this.accountStates.get(accountId)
    if (!state) return null

    const now = Date.now()
    const keysToDelete: string[] = []

    state.sessionIds.forEach((session, id) => {
      if (now - session.createdAt >= session.ttl) {
        keysToDelete.push(id)
      }
    })

    for (const key of keysToDelete) {
      state.sessionIds.delete(key)
    }

    // Find first valid session
    let reusableSession: string | null = null
    state.sessionIds.forEach((session) => {
      if (!reusableSession && now - session.createdAt < session.ttl) {
        reusableSession = session.id
      }
    })

    return reusableSession
  }

  invalidateSession(accountId: string, sessionId: string): void {
    const state = this.accountStates.get(accountId)
    if (!state) return
    state.sessionIds.delete(sessionId)
  }

  // ============ Header Generation ============

  generateSecChUa(platform?: string): string {
    const v = this.currentBrowserVersion.chromeVersion
    if (platform === 'macOS' || platform === 'Linux') {
      return `"Chromium";v="${v}", "Google Chrome";v="${v}", "Not-A.Brand";v="24"`
    }
    return `"Chromium";v="${v}", "Not(A:Brand";v="8", "Google Chrome";v="${v}"`
  }

  generateHeaders(
    accountId: string,
    provider: string,
    baseHeaders: Record<string, string>
  ): Record<string, string> {
    const fingerprint = this.getAccountFingerprint(accountId)
    const dynamicHeaders: Record<string, string> = {
      'User-Agent': fingerprint.userAgentBase,
      'Sec-Ch-Ua': this.generateSecChUa(fingerprint.platform),
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': `"${fingerprint.platform}"`,
    }

    switch (provider) {
      case 'deepseek':
        dynamicHeaders['X-App-Version'] = this.generateDeepSeekAppVersion()
        dynamicHeaders['X-Client-Version'] = `1.${Math.floor(this.currentBrowserVersion.chromeVersion / 10)}.0`
        break
      case 'zai':
        dynamicHeaders['X-FE-Version'] = `prod-fe-1.0.${Math.floor(this.currentBrowserVersion.chromeVersion * 1.7)}`
        break
    }

    return { ...baseHeaders, ...dynamicHeaders }
  }

  private generateDeepSeekAppVersion(): string {
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    return `${year}${month}${day}.1`
  }

  // ============ Exponential Backoff ============

  async executeWithBackoff<T>(
    accountId: string,
    operation: () => Promise<T>,
    options: {
      maxRetries?: number
      baseDelay?: number
      maxDelay?: number
      shouldRetry?: (error: any) => boolean
    } = {}
  ): Promise<T> {
    const {
      maxRetries = 3,
      baseDelay = 1000,
      maxDelay = 60000,
      shouldRetry = (err: any) => {
        const status = err?.response?.status
        return status === 429 || (status >= 500 && status < 600)
      },
    } = options

    let lastError: any

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation()
      } catch (error) {
        lastError = error

        if (attempt === maxRetries || !shouldRetry(error)) {
          throw error
        }

        const delay = Math.min(
          baseDelay * Math.pow(2, attempt) + Math.random() * baseDelay,
          maxDelay
        )

        console.log(`[AntiDetection] Retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms`)
        await this.delay(delay)
      }
    }

    throw lastError
  }

  // ============ Request Jitter ============

  async addRequestJitter(accountId: string, minMs: number = 1000, maxMs: number = 3000): Promise<void> {
    const state = this.accountStates.get(accountId)
    if (!state) return

    const now = Date.now()
    const minInterval = minMs + Math.random() * (maxMs - minMs)

    if (state.lastRequestTime && now - state.lastRequestTime < minInterval) {
      const wait = minInterval - (now - state.lastRequestTime)
      await this.delay(wait)
    }
  }

  // ============ Utilities ============

  private createAccountState(accountId: string, maxRPM?: number): AccountState {
    const state: AccountState = {
      fingerprint: this.generateDeviceFingerprint(),
      rateLimit: this.createRateLimitState(maxRPM),
      cookies: new Map(),
      lastRequestTime: 0,
      requestCount: 0,
      sessionIds: new Map(),
    }
    this.accountStates.set(accountId, state)
    return state
  }

  private generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

export const antiDetectionService = new AntiDetectionServiceClass()
