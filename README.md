# SallyAlarm

GitHub 알림을 macOS 메뉴바에서 받아보는 개인용 데스크톱 앱.

## 개발 실행
```bash
npm install
npm run tauri dev
```

## 테스트
```bash
npm test
```

## 빌드
```bash
npm run tauri build
```

## 토큰
GitHub Settings → Developer settings → Personal access tokens 에서
`notifications` (classic) 또는 Notifications 읽기 권한(fine-grained) 토큰을 발급해
앱 첫 화면에 입력한다. 토큰은 macOS 키체인에 저장된다.
