# CLAUDE.md

이 파일은 이 저장소에서 작업할 때 Claude Code(claude.ai/code)에게 제공되는 안내 문서입니다.

## 명령어

```bash
pnpm install    # 의존성 설치 (electron)
pnpm start      # Electron 앱 실행 (electron .)
```

빌드 단계 없음. 테스트 미정의.

## 아키텍처

ClaudeZoo는 로컬 머신에 설치된 Claude Code 플러그인 생태계를 시각화하는 **Electron 데스크탑 앱**입니다.

### 프로세스 구조

| 파일 | 역할 |
|---|---|
| `main.js` | Electron 메인 프로세스 — `~/.claude/` 파일시스템 읽기, IPC 처리 |
| `preload.js` | IPC 브릿지 — `window.electronAPI.getEcosystemData()`를 렌더러에 노출 |
| `src/index.html` | 단일 파일 React SPA — 모든 컴포넌트, 스타일, JSX 인라인 포함 |

### 데이터 흐름

1. 렌더러가 `window.electronAPI.getEcosystemData()` 호출
2. `main.js` IPC 핸들러가 `~/.claude/`에서 읽기:
   - `plugins/installed_plugins.json` — 버전, 스코프, 경로 포함 플러그인 목록
   - `settings.json` — `enabledPlugins` 맵
   - `plugins/blocklist.json` — 차단된 플러그인 및 사유
   - 플러그인별 `commands/*.md` 파일(스킬)과 `.mcp.json`(MCP 서버)
3. 집계된 데이터가 단일 JSON 객체로 렌더러에 반환
4. React가 플러그인 카드와 상세 사이드바 렌더링

### 프론트엔드 (src/index.html)

React와 Babel은 CDN에서 로드 — 번들러 없음. JSX는 브라우저에서 트랜스파일. 주요 컴포넌트:

- **App** — 최상위 상태(`data`, `loading`, `activeTab`, `selectedPlugin`); 스코프별 탭 필터링 (전체 / 사용자 / 프로젝트 / 로컬)
- **PluginCard** — 요약 카드; 클릭 시 사이드바 열림
- **Sidebar** — 스킬(슬래시 명령어)과 MCP 서버 설정을 보여주는 상세 패널
