import { describe, it, expect } from 'vitest'
import { apiUrlToHtmlUrl } from './github'

describe('apiUrlToHtmlUrl', () => {
  it('pulls API URL을 web pull URL로 바꾼다', () => {
    expect(
      apiUrlToHtmlUrl('https://api.github.com/repos/o/r/pulls/123'),
    ).toBe('https://github.com/o/r/pull/123')
  })

  it('issues는 그대로 issues', () => {
    expect(
      apiUrlToHtmlUrl('https://api.github.com/repos/o/r/issues/45'),
    ).toBe('https://github.com/o/r/issues/45')
  })

  it('commits는 commit로 단수화', () => {
    expect(
      apiUrlToHtmlUrl('https://api.github.com/repos/o/r/commits/abc'),
    ).toBe('https://github.com/o/r/commit/abc')
  })

  it('null이면 알림 페이지로 폴백', () => {
    expect(apiUrlToHtmlUrl(null)).toBe('https://github.com/notifications')
  })
})
