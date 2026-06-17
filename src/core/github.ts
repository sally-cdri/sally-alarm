const KIND_MAP: Record<string, string> = {
  pulls: 'pull',
  issues: 'issues',
  commits: 'commit',
}

export function apiUrlToHtmlUrl(apiUrl: string | null): string {
  if (!apiUrl) return 'https://github.com/notifications'
  const m = apiUrl.match(
    /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/,
  )
  if (!m) return 'https://github.com/notifications'
  const [, owner, repo, kind, rest] = m
  const webKind = KIND_MAP[kind] ?? kind
  return `https://github.com/${owner}/${repo}/${webKind}/${rest}`
}
