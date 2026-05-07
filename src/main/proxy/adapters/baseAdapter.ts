/**
 * Base Adapter Helper
 * Shared anti-detection functionality for all provider adapters
 */

import { Account, Provider } from '../../store/types'
import { antiDetectionService } from '../services/antiDetectionService'

export class BaseAdapterHelper {
  protected account: Account
  protected provider: Provider
  protected accountId: string
  protected providerName: string

  constructor(account: Account, provider: Provider, providerName: string) {
    this.account = account
    this.provider = provider
    this.accountId = account.id
    this.providerName = providerName
  }

  /** Generate dynamic headers with anti-detection */
  generateDynamicHeaders(baseHeaders: Record<string, string>): Record<string, string> {
    return antiDetectionService.generateHeaders(this.accountId, this.providerName, baseHeaders)
  }

  /** Wait for rate limit before making request */
  async waitForRateLimit(maxRPM?: number): Promise<void> {
    await antiDetectionService.waitForRateLimit(this.accountId, maxRPM)
  }

  /** Get stored cookies for this account */
  getCookies(domain?: string): string {
    return antiDetectionService.formatCookies(this.accountId, domain)
  }

  /** Store cookies from response Set-Cookie header */
  storeCookies(setCookieHeader: string | string[]): void {
    const cookies = antiDetectionService.parseSetCookie(setCookieHeader)
    antiDetectionService.storeCookies(this.accountId, cookies)
  }

  /** Get or create a reusable session */
  getReusableSession(): string | null {
    return antiDetectionService.getReusableSession(this.accountId)
  }

  /** Store a session for reuse */
  storeSession(sessionId: string, ttlMs: number = 300000): void {
    antiDetectionService.storeSession(this.accountId, sessionId, ttlMs)
  }

  /** Invalidate a stored session */
  invalidateSession(sessionId: string): void {
    antiDetectionService.invalidateSession(this.accountId, sessionId)
  }

  /** Get device fingerprint for this account */
  getDeviceFingerprint() {
    return antiDetectionService.getAccountFingerprint(this.accountId)
  }

  /** Get persistent device ID */
  getDeviceId(): string {
    return this.getDeviceFingerprint().deviceId
  }

  /** Add timing jitter between requests */
  async addJitter(minMs: number = 1000, maxMs: number = 3000): Promise<void> {
    const jitter = minMs + Math.random() * (maxMs - minMs)
    await new Promise(resolve => setTimeout(resolve, jitter))
  }

  /** Execute with exponential backoff on retriable errors */
  async executeWithBackoff<T>(
    operation: () => Promise<T>,
    options?: {
      maxRetries?: number
      baseDelay?: number
      maxDelay?: number
    }
  ): Promise<T> {
    return antiDetectionService.executeWithBackoff(this.accountId, operation, options)
  }

  /** Add request interval jitter based on last request time */
  async addRequestJitter(minMs: number = 1000, maxMs: number = 3000): Promise<void> {
    await antiDetectionService.addRequestJitter(this.accountId, minMs, maxMs)
  }
}
