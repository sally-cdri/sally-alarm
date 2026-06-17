# 개인 GitHub 알림 메뉴바 앱 (sally-alarm) — 설계 문서

- 작성일: 2026-06-17
- 상태: 승인됨 (MVP 설계)

## 목표

GitHub에서 나에게 온 알림(멘션, 리뷰 요청, 내 PR에 달린 답글/리뷰 등)을
macOS 메뉴바에서 네이티브 토스트로 받아본다. 나중에 같은 구조로
Slack / Jira / Notion 을 추가한다.

MVP 범위는 **GitHub 단일 프로바이더**다.

## 기술 스택

- **Tauri** (Rust 백엔드 + 웹 프론트엔드) — 가볍고 네이티브 트레이/알림 지원.
  Rust 코드는 템플릿 기본 `main.rs` + 설정 수준으로 최소화하고, 로직은 TypeScript로 작성.
- **UI**: React + TypeScript
- **GitHub 인증**: Personal Access Token (PAT), `notifications` scope. 서버/OAuth App 불필요.

## 아키텍처

```
┌─────────────────────────────────────────────┐
│  Tauri 앱                                     │
│                                               │
│  [React/TS UI]         [Tauri 네이티브 기능]   │
│   - 메뉴바 드롭다운 패널   - 트레이 아이콘        │
│   - 알림 목록/설정        - OS 네이티브 알림      │
│        ↕                 - 자동시작/키체인       │
│  [Core (TS)]                                  │
│   - Provider 인터페이스 ◄── GitHubProvider     │
│   - 폴링 스케줄러            (이후 Slack 등 추가) │
│   - 중복제거/상태 store                         │
└─────────────────────────────────────────────┘
```

확장성의 핵심은 `NotificationProvider` 인터페이스다. GitHub은 첫 구현체이고,
이후 Slack/Jira/Notion 은 같은 인터페이스의 새 구현체만 추가하면 된다.

```ts
interface NotificationProvider {
  id: 'github' | 'slack' | 'jira' | 'notion'
  poll(since: Date): Promise<NotifItem[]>   // 새 알림 가져오기
}

interface NotifItem {
  id: string
  provider: string
  title: string
  body: string
  url: string
  timestamp: Date
  type: 'mention' | 'review' | 'reply' | 'review_request' | 'other'
}
```

## GitHubProvider 동작

- GitHub `/notifications` REST API 를 **PAT으로 폴링** (기본 60초 간격, 설정 가능).
- `If-Modified-Since` / `?since=` 를 활용해 rate limit 절약.
- 받은 항목을 로컬에 저장한 ID들과 비교 → **새 것만** 네이티브 토스트로 알림.
- 토스트/목록 클릭 → 기본 브라우저로 해당 PR/이슈/코멘트 URL 열기.

## 데이터 & 저장

- **PAT**: OS 키체인에 안전 저장 (Tauri keychain 플러그인). 평문 파일 저장 금지.
- **설정/읽음 상태**: 로컬 JSON (폴링 간격, 마지막 폴링 시각, 본 알림 ID 목록).
- MVP는 **읽음 상태를 GitHub로 역동기화하지 않음** (로컬에서만 중복 방지). YAGNI.

## UI (메뉴바 중심)

- 트레이 아이콘: 안 읽은 알림이 있으면 배지/점 표시.
- 클릭 → 드롭다운 패널: 최근 알림 리스트(제목·타입·시간), 클릭 시 열기.
- 패널 하단: 설정(PAT 입력, 폴링 간격), "모두 읽음".

## 에러 처리

- 네트워크 실패 → 조용히 다음 주기 재시도, 트레이에 연결 끊김 표시.
- 401(토큰 만료/무효) → 토스트로 "토큰 다시 입력" 안내.
- rate limit 근접 → 자동으로 폴링 간격 늘림(백오프).

## 테스트

- Core(Provider 인터페이스, 폴링/중복제거 로직)는 TS 유닛 테스트 — GitHub API는 mock.
- 네이티브 레이어(트레이/토스트)는 수동 확인.

## MVP에서 의도적으로 제외 (이후 확장)

- Slack / Jira / Notion (구조만 열어둠)
- 읽음 상태 GitHub 역동기화
- 알림 필터링/규칙, 멀티 계정
