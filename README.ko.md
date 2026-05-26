<div align="center">

<sub><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <b>한국어</b> · <a href="README.es.md">Español</a></sub>

<h1>open-browser-use</h1>

<p><b>이미 쓰고 있는 그 브라우저를 에이전트가 직접 조작하게 하세요.</b></p>

<img src="open-browser-use-readme-preview-wide.png" alt="open-browser-use — agent browser tool, agentic RL ready" width="820">

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="Status: public preview" src="https://img.shields.io/badge/status-public%20preview-orange?style=flat-square">
  <img alt="Platforms: macOS and Linux" src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux-lightgrey?style=flat-square">
  <br>
  <img alt="Built with Rust" src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white">
  <img alt="Built with TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Model Context Protocol" src="https://img.shields.io/badge/MCP-server-7C3AED?style=flat-square">
</p>

</div>

---

코딩 에이전트는 추론하고, 계획하고, 코드를 작성할 수 있습니다. 하지만 작업이 로그인 뒤에 있거나, API가 없는 대시보드 안에 있거나, 클릭을 거듭해야 하는 여러 단계의 웹 폼 속에 있는 순간 벽에 부딪힙니다. 머리는 충분한데, 브라우저를 만질 손이 없는 거죠. **open-browser-use는 바로 그 손을 쥐여 줍니다** — 이미 로그인되어 있는 *당신의* 진짜 브라우저를, 온전히 당신의 컴퓨터 안에서 조작하면서요.

## 에이전트에게는 머리는 있지만 손이 없습니다

우리는 에이전트에게 "알아서 처리해 줘"라고 말하기를 좋아합니다. 문제는 그 *처리할 일* 중 상당수가 브라우저 탭 안에 있다는 점이죠:

- "이번 분기 이메일에서 모든 청구서를 받아서 합계를 내 줘."
- "이미 로그인되어 있는 그 매장에서 늘 사던 식료품을 다시 주문해 줘."
- "이 대시보드에서 숫자를 뽑아 줘 — 내보내기 버튼이 없거든."
- "저 PDF의 정보를 가지고 이 신청서를 작성해 줘."

이 중 어느 것도 *생각하기* 어려운 일은 아닙니다. 어려운 이유는 에이전트가 페이지를 *만질* 수 없기 때문입니다. open-browser-use는 그 간극을 메우되, 가능한 한 부담 없는 방식으로 그렇게 하려고 합니다:

- **당신의 진짜 브라우저, 당신의 세션.** 새로 띄운, 로그아웃된 로봇 브라우저가 아니라 이미 쓰고 있는 Chrome을 당신의 로그인과 쿠키 그대로 조작합니다. 그래서 *실제* 심부름을 해낼 수 있죠.
- **로컬에서, 프라이빗하게.** 모든 것이 당신의 컴퓨터에서 돌아갑니다. 클라우드도, 계정도, 외부로 데이터를 보내는 일도 없습니다.
- **이미 쓰는 에이전트와 그대로 연동.** Codex, Claude Code, Cursor, Gemini CLI, VS Code 등과 Model Context Protocol(MCP)을 통해 연결됩니다.
- **오픈 소스**, MIT 라이선스.

## 설치 (현재 프리뷰)

open-browser-use는 **macOS / Linux 퍼블릭 프리뷰**입니다 — Chrome 웹 스토어 등록이 아직 공개되지 않아서, 확장 프로그램은 GitHub Releases를 통해 배포됩니다. 손으로 직접 설정할 것은 단 하나, 브라우저 확장 프로그램뿐입니다. 나머지는 AI 에이전트가 알아서 설치하고 연결해 줍니다.

1. 최신 릴리스에서 **[확장 프로그램 다운로드](https://github.com/open-browser-use/open-browser-use/releases/latest/download/open-browser-use-extension.zip)** 후 압축을 풉니다.
2. **브라우저에 불러오기:** `chrome://extensions`(Chrome 또는 다른 Chromium 브라우저)를 열고, **개발자 모드**를 켠 다음, **압축해제된 확장 프로그램을 로드합니다**를 클릭하고 압축을 푼 폴더를 선택합니다. 핀으로 고정해 두세요 — 다음 단계에서 에이전트를 연결할 때 이 팝업을 사용합니다.

> [!NOTE]
> Chrome 웹 스토어 등록이 공개되면 다운로드나 압축 해제 없이 스토어에서 바로 확장 프로그램을 추가할 수 있습니다. 플랫폼별 참고 사항과 문제 해결은 [docs/install.md](docs/install.md)와 [docs/troubleshooting.md](docs/troubleshooting.md)를 참고하세요.

## 빠른 시작

확장 프로그램을 불러왔다면, 코딩 에이전트와 연결하는 데는 1분 정도면 충분합니다 — 직접 손볼 설정 파일은 없습니다:

1. **확장 프로그램 팝업을 열고** **Copy for agent**를 클릭합니다.
2. 복사한 내용을 **코딩 에이전트에 붙여 넣습니다**(Codex, Claude Code, Cursor, Gemini CLI, …).
3. 에이전트가 **open-browser-use MCP 서버를 설정하고 당신의 브라우저에 연결합니다.** 이게 전부입니다.

> [!TIP]
> 그러고 나면 그냥 평범한 말로 부탁하면 됩니다:
> *"내 GitHub 알림을 열어서 실제로 내가 챙겨야 할 게 뭔지 정리해 줘."*

## 에이전트가 할 수 있는 일

내부적으로 에이전트는 하나의 `js` 도구를 호출하고 Playwright 형태의 SDK(`agent` 글로벌)를 대상으로 코드를 작성합니다. 브라우저 작업 한 턴 전체가 대략 이 정도로 짧습니다:

```js
const browser = await agent.browsers.get("chrome");
const tab = await browser.tabs.current();
await tab.attach();                                   // 탭의 제어권을 가져온다
await tab.goto("https://news.ycombinator.com");
await tab.getByRole("link", { name: "new" }).click();
display(await tab.locator("h1").innerText());         // 결과를 표시한다
await browser.turnEnded();                            // 세션은 유지한 채 제어권을 돌려준다
```

여기서부터 에이전트는 다음을 할 수 있습니다:

| 기능                         | 의미                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **요소에 액션 수행**          | 클릭, 입력, 타이핑, 키 누르기, 선택, 호버 — 역할, 텍스트, 또는 CSS로 지정합니다(견고한 Playwright 방식).                  |
| **시각 또는 DOM id로 클릭** | 깔끔한 선택자가 없을 때를 위한 비전/좌표 및 DOM 기반 방식 — 교차 출처(cross-origin) iframe을 가로지르는 것까지 포함합니다. |
| **읽기 및 추출**           | 텍스트, 표, 속성, 스크린샷.                                                                                  |
| **파일 및 다이얼로그**          | 업로드, 다운로드, 알림(alert), 확인(confirm).                                                                                   |
| **탭, 세션 및 재개**  | 여러 탭과 세션을 다루고, 진행 상황을 잃지 않고 여러 턴에 걸쳐 긴 작업을 이어갑니다.                             |

## 동작 방식

에이전트는 open-browser-use를 MCP 서버로 보고 대화합니다. 단일 `js` 도구를 통해 JavaScript를 작성하면, 그 코드는 `agent`가 SDK인 영속적인 Node 런타임에서 실행됩니다. 이 호출들은 기능(capability) 단위로 게이팅되는, 소유자 전용 Unix socket을 통해 JSON-RPC로 **`obu-host`**에 전달됩니다 — `obu-host`는 세션마다 동작하는 브로커로, 두 가지 백엔드 중 하나를 통해 브라우저를 조작합니다:

```
your agent
   │  MCP over stdio              (the `js` tool; you write JS, the SDK is `agent`)
   ▼
obu-node-repl                     (MCP server + the Node runtime it spawns)
   │  JSON-RPC over an owner-only Unix socket   (capability-gated)
   ▼
obu-host                          (per-session broker daemon)
   ├─▶ WebExtension backend ─▶ your everyday Chrome        (MV3 + native messaging, no debug port)
   └─▶ CDP backend          ─▶ Chrome with remote debugging   (OBU_CDP_URL)
```

- **WebExtension 백엔드** — open-browser-use 확장 프로그램을 통해 일반적으로 설치된 Chrome을 조작합니다. `--remote-debugging-port`도 필요 없고, 당신의 실제 프로필과 로그인이 그대로 유지됩니다. 일상적인 사용에서는 이것이 기본값입니다.
- **CDP 백엔드** — 원격 디버깅으로 실행된 Chrome(`OBU_CDP_URL`)에 연결합니다. 헤드리스 및 스크립트 기반 실행에 이상적입니다.

> [!IMPORTANT]
> 모든 것이 당신의 컴퓨터 안에 머뭅니다. `obu-host`의 소켓은 소유자 전용이며 OS 사용자 기준으로 인증되고, 거기에 도달할 수 있는 기능 토큰은 신뢰된 SDK 코드만 가집니다 — open-browser-use는 원격 서비스로 절대 호출을 내보내지 않습니다.

<details>
<summary><b>저장소 구조</b> — 각 구성 요소가 어디에 있는지</summary>

| 경로                              | 무엇인지                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `crates/obu-wire`               | 공용 JSON-RPC 프레이밍, 봉투(envelope), 오류 코드.                                                                  |
| `crates/obu-node-repl`          | MCP 서버: Node 런타임(SDK가 실행되는 곳)을 띄우고, 기능 게이팅된 소켓을 `obu-host`로 중개합니다. |
| `crates/obu-host`               | 세션별 브로커 데몬과 CDP / WebExtension 백엔드.                                                    |
| `packages/sdk`                  | 에이전트를 마주하는, Playwright 형태의 TypeScript SDK(`@open-browser-use/sdk`).                                       |
| `packages/browser-control-core` | SDK와 확장 프로그램이 공유하는 순수 프로토콜 타입, 플래너, 픽스처.                                          |
| `packages/cli`                  | `obu` 명령줄 — `setup`, `verify`, `doctor`, 그리고 에이전트 MCP 연결.                                  |
| `packages/extension`            | Chromium MV3 확장 프로그램과 그 네이티브 호스트 브리지.                                                                |

</details>

## 에이전틱 RL 환경

open-browser-use는 브라우저 에이전트를 단지 *실행*하는 데 그치지 않고, **학습하고 평가하는 환경**으로도 쓸 수 있게 설계되었습니다. 강화학습 코어는 이미 존재하며, 남은 것은 그 주위를 감싸는 하네스입니다.

**이미 갖춰진 것**

- **환경 형태의 액션/관측 루프.** `tab.observe()`는 타입이 지정된 `TabObservation`을 반환하고, `tab.step(action)`은 타입이 지정된 `EnvAction`을 받아 `ActionResult`를 반환합니다. `EnvAction`은 세 가지 주소 지정 방식 — `locator.*`, `dom_cua.*`, `coordinate.*` — 에 걸쳐 **13가지 액션 종류**를 아우르며, 각각 선택적인 기능 `policy`를 가질 수 있습니다.
- **풍부하고 구조화된 스텝 결과.** `ActionResult`는 `ActionEffect`(`navigation`, `dom_changed`, `download_started`, `no_visible_change`, …), `invalidatedObservations`, 핸들, 권고(advisory), 그리고 구조화된 `error`를 보고합니다 — 학습기나 검증기를 구동하기에 충분한 신호입니다.
- **복구 가능한 내구성 있는 에피소드.** 세션은 소유권 중재, 오래된 핸들 진단, 소유자 턴 증명, 그리고 `resume`을 갖추고 있어, 긴 에피소드가 충돌과 재연결을 견뎌냅니다. 작업은 `EpisodeExport { task_id, turns, events }`로 내보낼 수 있습니다.
- **고수준 헬퍼**(`tab.act.*`, `tab.flows`, `tab.read`) — 동일한 기본 요소 위에 얹혀 있습니다.

**아직 없는 것** — 정형화되고 샘플링 가능한 `reset/step/observe/close`를 노출하는 단일 `Environment` 파사드가 없습니다. `browser.reset()`은 뷰포트만 리셋합니다(백엔드가 일회용 브라우저를 띄우는 게 아니라 기존 브라우저에 연결하기 때문입니다). 그리고 기본 제공되는 검증기 기반 구조, 보상이 담긴 트라젝터리 스키마, 병렬 롤아웃 플릿, 또는 Python / 네트워크(HTTP/gRPC) 클라이언트도 아직 없습니다 — 현재의 표면은 MCP-stdio와 네이티브 파이프 브로커입니다.

### 학습 가능한 환경으로 가는 로드맵

*"이걸로 실제로 학습을 돌릴 수 있는가"*에 이르는 핵심 경로 순으로 정렬했습니다:

- [ ] **Env 파사드 + 언어 중립 프로토콜 + Python 클라이언트** *(키스톤)* — `reset/step/observe/close`를 HTTP/gRPC 표면(또는 흔히 쓰는 RL 프레임워크용 어댑터) 뒤로 수렴시켜, 외부 학습기가 대규모로 롤아웃을 구동할 수 있게 합니다.
- [ ] **깨끗하고 시드 가능한 `reset()`** — 백엔드가 새 프로필과 고정된 시작 URL로 일회용 브라우저를 띄우고 에피소드가 끝나면 정리하게 합니다. 이 한 가지 기능이 리셋*과* 병렬성을 동시에 열어 줍니다.
- [ ] **검증기 기반 구조(RLVR)** — 결정론적 단언 라이브러리(`url_contains`, `text_visible`, `dom_query`, `download_produced`, JS 술어)와 `episode.evaluate({ assertions })`.
- [ ] **학습용 트라젝터리 스키마** — `EpisodeExport.turns`를 `(obs, action, effect, reward, done)` 레코드로 타입화하고, 표준 JSONL / Hugging Face 데이터셋 내보내기를 지원합니다.
- [ ] **병렬 롤아웃 플릿** — 비동기 스테핑을 갖춘 N개의 격리된 브라우저 풀(깨끗한 리셋 위에 세워집니다).
- [ ] **결정론과 재현성** — 시딩, 선택적 네트워크 기록/재생, 그리고 라이브 웹의 변동을 감지하기 위한 콘텐츠 해싱이 적용된 고정 작업 인스턴스.

## 기본은 로컬

open-browser-use는 원격 URL이나 제품 정책 서비스를 절대 호출하지 않습니다. SDK 가드와 호스트 정책은 로컬에서 실행되며 기본적으로 허용적입니다. 필요할 때 환경 변수로 조여 두세요:

| 변수                                                                      | 효과                                                               |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `OBU_HOST_POLICY_DENY_ORIGINS`                                              | 나열된 출처에 대해 내비게이션과 현재 출처 명령을 차단합니다. |
| `OBU_HOST_POLICY_DENY_CDP_METHODS`                                          | 특정 원시 CDP 메서드를 차단합니다(`*`는 전체 차단).                   |
| `OBU_HOST_POLICY_BLOCK_HISTORY` / `_BLOCK_DOWNLOADS` / `_BLOCK_UPLOADS` | 히스토리 읽기, 다운로드, 또는 업로드를 차단합니다.                          |
| `OBU_GUARD_MODE=disabled`                                                   | 모든 가드 및 정책 검사를 우회합니다(로컬/테스트용).                |

SDK 호출 측은 내비게이션, 다운로드, 업로드, 히스토리, 원시 CDP에 대해 브라우저별 `Guards` 훅을 설치할 수도 있습니다 — 이 훅들은 로컬 에이전트 프로세스 안에서 실행되며 어떤 네트워크 요청도 하지 않습니다:

```ts
import { Guards } from "@open-browser-use/sdk";

const browser = await agent.browsers.get("chrome", {
  guards: new Guards({
    checkNavigation(url) {
      if (url.startsWith("https://admin.example/")) throw new Error("navigation blocked");
    },
  }),
});
```

## 빌드 및 테스트

```bash
cargo test --workspace
pnpm install --frozen-lockfile
pnpm -r build && pnpm -r test
```

와이어 메서드 이름, SDK 가드 클래스, 호스트 정책 클래스, 백엔드 지원 상태는 모두 `wire/methods.json`에서 나옵니다. 와이어 메서드를 변경한 뒤에는 TS/Rust 테이블을 다시 생성하고 최신성 검사를 실행하세요:

```bash
pnpm generate:wire-methods
pnpm check:wire-methods
```

패키징, 커버리지, 그리고 무시 처리된 CDP / WebExtension 엔드투엔드 게이트에는 각각의 스크립트와 설정이 있습니다. [docs/install.md](docs/install.md), [docs/troubleshooting.md](docs/troubleshooting.md), [docs/release-checklist.md](docs/release-checklist.md)를 참고하세요.

## 라이선스 및 고지

open-browser-use는 MIT 라이선스를 따릅니다 — [LICENSE](LICENSE)를 참고하세요. 릴리스 페이로드에는 상위 라이선스를 따르는 서드파티 구성 요소도 포함되어 있습니다. 자세한 내용은 [LICENSE-THIRD-PARTY.md](LICENSE-THIRD-PARTY.md)에 있습니다.

---

<div align="center">
<sub>Rust + TypeScript로 제작 · Model Context Protocol을 통해 구동 · macOS / Linux 퍼블릭 프리뷰</sub>
</div>
