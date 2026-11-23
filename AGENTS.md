# UnityBrain Autonomous Agent Instructions (`AGENTS.md`)

> 이 파일은 `d:\Noogs\NextCloud\Projects\UnityBrain` 워크스페이스를 여는 모든 AI 코딩 에이전트(Antigravity, Codex, Cursor, Windsurf, Gemini CLI, Claude Code 등)가 **사용자 개입이나 중간 승인 질문 없이 자율적으로 개발을 끝까지 완수**하기 위해 따라야 할 최상위 작업 규칙이다.

---

## 1. 핵심 자율 실행 원칙 (Zero-Interruption Rules)

1. **대화형 승인 및 확인 질문 전면 금지 (No Conversational Confirmation)**
   * `PLAN.md`와 `docs/plans/01~06.md`에 이미 아키텍처, 파일 경로, 심볼명, 데이터 계약이 확정되어 있다.
   * **"계속 진행할까요?", "다음 파일을 생성해도 될까요?", "이 방식으로 구현해도 될까요?"** 같은 확인 질문으로 턴을 멈추지 마라.
   * 세부 구현 선택이 필요할 때는 `PLAN.md` 및 해당 `docs/plans/0X-*.md`의 설계 의도와 타입 계약에 가장 부합하는 표준 방식을 스스로 결정하고 즉시 구현하라.

2. **자동 승인(Always Allow) 친화적 명령어 형태 강제 (Prefix-Matchable Command Shapes)**
   * 에이전트 IDE/CLI의 **"Always Allow(항상 허용)"** 접두사 매칭이 깨져 매번 사용자 확인 팝업이 뜨는 것을 방지하기 위해 아래 셸 작성 규칙을 **절대 준수**한다:
     * **금지 구문**: 명령어 치환(`$(...)`, 백틱), 셸 변수 확장(`$VAR`, `${VAR}`), 중괄호 확장(`{a,b}`), `eval` / `env` / `xargs` 래퍼, 서로 다른 바이너리를 세미콜론(`;`)이나 `&&`로 이어 붙인 복합 체인 금지.
     * **단일 접두사 실행**: 한 번의 셸 도구 호출에는 **하나의 단일 명령어**만 실행하며, 반드시 아래 표준 바이너리 접두사 중 하나로 시작한다:
       * `pnpm ...`
       * `dotnet ...`
       * `git ...`
       * `node ...`
     * 여러 명령을 실행해야 할 때는 한 줄로 묶지 말고 **개별 도구 호출로 분리**하여 실행한다.

3. **워크스페이스 내부 샌드박스 준수 (Workspace-Scoped Execution)**
   * 모든 파일 생성·수정·테스트·임시 픽스처 작업은 반드시 워크스페이스 루트(`d:\Noogs\NextCloud\Projects\UnityBrain`) 내부에서만 수행한다.
   * 외부 드라이브, 시스템 디렉터리, 사용자 홈 디렉터리 접근을 시도하여 샌드박스 우회(Bypass) 승인 요청을 유발하지 마라.
   * `.ref/resharper-unity` 등 참조 저장소 역시 프로젝트 루트 하위 `.ref/`에만 둔다.

4. **실패 시 자가 복구 루프 (Autonomous Self-Healing)**
   * 빌드(`tsc`, `dotnet build`) 또는 테스트(`vitest`, `dotnet test`)가 실패하면 사용자에게 보고하고 멈추지 마라.
   * 컴파일 에러·스택 트레이스를 직접 읽고 프로덕션 코드를 수정한 뒤 테스트를 재실행하여 **100% 통과할 때까지 자율적으로 반복**하라.
   * 테스트 assertion을 완화·삭제·skip하는 우회는 절대 금지한다.

5. **연속 단계 진행 규칙 (Continuous Step Progression)**
   * 사용자가 여러 Step 또는 전체 Phase(또는 `ALL`) 실행을 지시한 경우, Step $N$의 검증 테스트가 통과하는 즉시 확인 질문 없이 곧바로 Step $N+1$을 시작한다.

6. **작업별 사용자 직접 검증 가이드 필수 첨부 (Mandatory User Verification Guide per Task)**
   * 모든 구현·수정 작업의 최종 응답에는 사용자가 VS Code / Unity 환경에서 직접 재현하고 확인할 수 있는 **수동 검증 절차(파일 경로, 입력 예시 코드, 기대 동작/출력, 실행 명령)**를 각 변경점마다 빠짐없이 포함한다.

7. **테스트용 빌드(VSIX) 필수 제공 (Mandatory Testable VSIX Build)**
   * 모든 구현·수정 작업이 완료되면 테스트 통과 후 반드시 `packages/extension/package.json`과 루트 `package.json`의 **패치 버전(`x.y.z` → `x.y.(z+1)`)을 올린 뒤** 확장 번들 빌드(`node tools/cli.mjs build:extension`)와 VSIX 패키징(`node tools/cli.mjs package:vsix`)을 실행하여, VS Code에서 버전 충돌 없이 바로 설치해 테스트할 수 있는 최신 `.vsix` 빌드 파일 경로를 최종 응답에 함께 제공한다.

---

## 2. 체크포인트 및 한도(Limit) 초기화 후 이어하기 프로토콜

모델의 사용량 한도(Rate Limit / Quota Limit)로 작업이 도중에 끊기더라도 다음 턴이나 새 모델이 중단 지점부터 즉시 이어갈 수 있도록 아래 체크포인트 프로토콜을 **필수**로 실행한다.

1. **세션 시작 시 `PROGRESS.json` 최우선 확인**
   * 작업을 시작할 때마다 가장 먼저 루트의 `PROGRESS.json`을 읽고, `steps` 배열에서 `status`가 `"in_progress"`이거나 첫 번째 `"pending"`인 Step을 찾는다.
   * `overallStatus`가 `"completed"`이면 추가 작업을 중단하고 최종 완료 상태를 보고한다.
2. **파일 단위 마이크로 체크포인트 갱신**
   * Step $X$를 시작하기 직전: `PROGRESS.json`의 `overallStatus`를 `"in_progress"`, `currentStepId`를 `X`, 해당 Step의 `status`를 `"in_progress"`, `lastUpdatedAt`을 현재 시각으로 갱신한다.
   * `targetFiles` 중 파일 1개를 작성·수정 완료할 때마다 즉시 `PROGRESS.json`의 해당 Step `completedFiles` 배열에 그 파일 경로를 추가하고 `resumeNote`에 다음 작업할 파일/상황을 1줄로 기록한다.
   * Step $X$의 모든 `verificationCommands`가 100% 통과한 직후:
     1. 해당 Step의 `status`를 `"completed"`로 변경하고 `currentStepId`를 다음 미완료 Step ID로 갱신한다(마지막 Step 완료 시 `overallStatus`를 `"completed"`로 변경).
     2. 로컬 Git 체크포인트 커밋을 수행한다(`git add -A` 호출 후 `git commit -m "chore(checkpoint): complete Step X"` 호출 — 단일 명령어 규칙 준수).
3. **`in_progress` 상태 중단 복구 알고리즘**
   * 재개 시 대상 Step의 `status`가 이미 `"in_progress"`라면, `completedFiles`에 기록된 파일들은 이미 구현된 것으로 간주하고 **불필요하게 처음부터 다시 작성하지 않는다**(단, 컴파일·테스트 에러가 발생한 파일만 수정).
   * `targetFiles` 중 `completedFiles`에 없는 나머지 파일부터 순서대로 구현을 이어가고, `verificationCommands`를 통과시킨 뒤 Step을 완료 처리한다.
   * 선택 단계(`optional: true`, 예: `2-2`)에서 실행 조건(로컬 Rider/REA)이 충족되지 않으면 `status`를 `"skipped"`로 기록하고 즉시 다음 Step으로 넘어간다.

---

## 3. 불변 아키텍처 제약 (Never Violate)

* **공유 계약 단일 진실 공급원**: `PLAN.md §3` 및 `packages/extension/src/contracts/index.ts`의 인터페이스 필드명, 타입, 경로를 임의로 변경하지 마라.
* **대상 프로젝트 무오염 원칙 (Zero Workspace Pollution)**: 대상 Unity 프로젝트 폴더에는 `.csproj` 수정, `Directory.Build.props` 생성, `.gitignore` 수정 등 확장 프로그램에 의한 어떤 파일 변경도 수행하지 마라. C# 정적 진단은 이미 설치된 C# 확장의 LSP(`executeHoverProvider` 등)와 확장 내부 경량 TS 분석기로 처리한다.
* **중복 구현 금지**: `Microsoft.Unity.Analyzers` (`UNT0001`~`UNT0038`, `USPxxxx`) 규칙을 재구현하지 마라. 신규 진단은 `UB1xxx`~`UB4xxx` 대역만 사용한다.
* **완전한 구현**: `// TODO`, `// ... existing code`, `NotImplementedException` 등 미완성 스텁을 남기지 마라.

---

## 4. 필독 문서 맵

* 진행 상태 체크포인트: `PROGRESS.json`
* 마스터 아키텍처 & 공유 스키마: `PLAN.md`
* 단계별 프롬프트 & 검증 명령어: `docs/AI_EXECUTION_PLAYBOOK.md`
* 세부 설계서:
  * `docs/plans/01-core-and-virtual-vfs.md`
  * `docs/plans/02-shaderlab-hlsl-lsp.md`
  * `docs/plans/03-smart-domain-completion.md`
  * `docs/plans/04-roslyn-analyzers-and-codefixes.md`
  * `docs/plans/05-yaml-asset-indexer-and-codelens.md`
  * `docs/plans/06-meta-sync-and-integration.md`
