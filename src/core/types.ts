export type ProviderId = 'github' | 'slack' | 'jira' | 'notion' | 'figma' | 'confluence'

export type NotifType =
  | 'mention'
  | 'review'
  | 'reply'
  | 'review_request'
  | 'assign'
  | 'author'
  | 'approved'
  | 'other'

export interface NotifItem {
  id: string
  provider: ProviderId
  title: string
  body: string
  url: string // 브라우저에서 열 URL
  timestamp: string // ISO 8601
  type: NotifType
  read: boolean // GitHub 읽음 여부 (false = 미읽음)
  preview?: string // 최신 코멘트 본문 미리보기 (있을 때만)
}

export interface PollOptions {
  since?: string
  lastModified?: string
}

export interface PollResult {
  items: NotifItem[]
  notModified: boolean
  lastModified?: string
  pollIntervalSec?: number
}

export interface NotificationProvider {
  readonly id: ProviderId
  poll(opts?: PollOptions): Promise<PollResult>
}

export interface PollerState {
  lastModified?: string
  seenIds: string[]
}
