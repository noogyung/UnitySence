# UnityBrain AI 작업 실행 플레이북 (AI Operator Playbook)

> **상위 마스터 문서**: [../PLAN.md](../PLAN.md)  
> **문서 목적**: 사용자가 여러 AI(ChatGPT, Claude, Gemini, Cursor, Antigravity, Codex 등)를 조합해 `UnityBrain` 프로젝트를 자동으로 구축할 때, **어디서 · 어떤 파일을 첨부하고 · 어떤 정확한 명령(프롬프트)을 내려야 하는지** 단계별로 정의한 실전 운영 매뉴얼이다.

---

## 1. 사전 환경 준비 (Step 0: AI 실행 전 로컬 1회 세팅)

AI에게 코드를 짜기 전에 사용자 로컬 개발 환경과 참조 소스를 먼저 준비해야 AI가 환각 없이 정확한 API와 원본 로직을 참조한다.

### 1.1 필수 개발 도구 설치 확인 (PowerShell)
```powershell
node -v     # v20.x 이상 권장
pnpm -v     # v9.x 이상 권장 (미설치 시: npm install -g pnpm)
dotnet --version  # 8.0.x 이상 필수
git --version
```

### 1.2 참조 오픈소스(`resharper-unity`) 및 REA(`morluto/rea`) 준비
작업 루트(`d:\Noogs\NextCloud\Projects\UnityBrain`)의 터미널에서 실행한다.

```powershell
Set-Location d:\Noogs\NextCloud\Projects\UnityBrain

# 1. JetBrains 공식 오픈소스(Apache 2.0)를 참조 전용 숨김 폴더(.ref)에 클론
git clone --depth 1 https://github.com/JetBrains/resharper-unity.git .ref/resharper-unity

# 2. 빌드/깃 커밋 대상에서 .ref 및 캐시 제외
@"
node_modules/
dist/
bin/
obj/
.ref/
*.vsix
"@ | Out-File -Encoding utf8 .gitignore

# 3. (선택) 비공개 바이너리(Rider 셰이더 DLL / vstuc) 정적 분석이 필요할 때만 REA 설정
npx rea-agents@latest setup
```

> **왜 `.ref/resharper-unity`를 받는가?**  
> `api.xml` 원본과 `UnityCgIncludeDirectoryProvider.cs`, `PerformanceCriticalCodeAnalysis` 원본 C# 로직이 로컬에 있으면, AI에게 "추측해서 짜라" 대신 **"`.ref/resharper-unity/...` 경로를 읽고 이식하라"**고 지시할 수 있어 정확도가 극대화된다.

### 1.3 무중단 자율 실행(Unattended Auto-Run) 환경 설정 및 명령어 규칙

이 프로젝트는 사용자의 개인정보나 시스템 외부 파일에 접근하지 않고 오직 `d:\Noogs\NextCloud\Projects\UnityBrain` 내부에서만 빌드와 테스트를 수행한다. AI가 작업 도중 사용자에게 허락을 구하며 멈추는 원인은 다음 3가지이며, 아래 공식 설정으로 모두 제거할 수 있다.

1. **원인 ① 대화형 확인 질문 ("진행할까요?")** → 워크스페이스 루트의 **[AGENTS.md](../AGENTS.md)** 및 **[CLAUDE.md](../CLAUDE.md)** 에 의해 전면 금지된다.
2. **원인 ② 복합 셸 구문이 IDE의 '항상 허용(Always Allow)' 접두사 매칭을 깨뜨림** → 세미콜론(`;`), `&&`, `$(...)`, `$VAR`, PowerShell 파이프를 사용하면 도구가 안전을 위해 명령어 문자열 전체를 매번 새로 승인 요청한다. 모든 프롬프트와 검증 명령을 **`pnpm ...`, `dotnet ...`, `git ...`, `node ...` 단일 명령어 1회 호출**로 분리하면 최초 1회 접두사 승인 후 재질문 없이 자동 통과된다.
3. **원인 ③ 워크스페이스 외부 경로 또는 네트워크 접근** → `Step 0`에서 `.ref/resharper-unity` 클론과 `pnpm install`(외부 레지스트리)을 먼저 마쳐두면, 이후 구현·테스트 단계에서는 모든 작업이 워크스페이스 내부 샌드박스 안에서만 실행되어 권한 상승 프롬프트가 뜨지 않는다.

#### 도구별 공식 무중단 실행 설정 가이드

* **Antigravity**:
  1. 채팅창에서 **`/goal`** 슬래시 명령어를 사용해 장기 자율 목표 모드로 작업을 시작한다.
  2. 첫 번째 `pnpm ...` 및 `dotnet ...` 명령 실행 시 **Always Allow(항상 허용)** 를 한 번만 선택하면, 이후 `AGENTS.md` 규칙에 따라 단일 접두사로 실행되는 모든 빌드/테스트 명령이 중단 없이 통과된다.
* **Claude Code CLI**:
  * 워크스페이스 내 `.claude/settings.json` 파일(사용자 로컬 프로젝트 설정)에 허용할 도구와 명령어 접두사를 공식 스키마로 지정한다:
  ```json
  {
    "permissions": {
      "allow": [
        "Read",
        "Edit",
        "Write",
        "Bash(pnpm *)",
        "Bash(dotnet *)",
        "Bash(node *)",
        "Bash(git status *)",
        "Bash(git diff *)"
      ]
    }
  }
  ```
* **Cursor / Windsurf**:
  * Settings의 **Agent Auto-Run / Command Allowlist**에 `pnpm`, `dotnet`, `node`, `git` 접두사를 추가하고, **Auto-Run Mode**를 켠다. (`AGENTS.md`가 자동으로 로드됨)
* **Codex CLI / Gemini CLI**:
  * 워크스페이스 루트에서 실행 시 `AGENTS.md`를 자동 로드한다. 공식 자동 승인 실행 모드(예: Codex CLI `--full-auto` 또는 `approval_policy = "on-request"` / 프로젝트 신뢰 설정, Gemini CLI `--approval-mode auto_edit` 또는 허용 도구 설정)로 실행한다.

### 1.4 모델 Limit(할당량·속도 제한) 도달 시 자동 이어하기(Auto-Resume) 설계 및 실행법

장시간 작업 중 모델의 Rate Limit(분당/시간당 요청 제한) 또는 Quota Limit(사용량 한도)에 걸려 실행이 중단되더라도, **한도가 풀리는 즉시(또는 다른 모델로 전환해) 하던 파일과 Step부터 100% 이어서 진행**할 수 있도록 3중 복구 체계를 제공한다.

* **핵심 동작 원리 (3-Layer Checkpoint)**:
  1. **마이크로 체크포인트 ([PROGRESS.json](../PROGRESS.json))**: 모든 에이전트는 Step 시작 시 `status: "in_progress"`를 기록하고, `targetFiles` 중 **파일 1개를 작성할 때마다 `completedFiles` 배열에 즉시 기록**한다. Limit가 파일 생성 중간에 걸려도 어디까지 완성되었는지 디스크에 남는다.
  2. **매크로 체크포인트 (Git Commit)**: Step 검증 테스트가 통과할 때마다 `git commit -m "chore(checkpoint): complete Step X"`를 남겨 언제든 클린한 상태로 복원할 수 있다.
  3. **복구 알고리즘 (`AGENTS.md §2`)**: 재개된 모델은 `PROGRESS.json`을 읽고 `completedFiles`에 이미 들어 있는 파일은 건너뛰며, 미완성 `targetFiles`와 `verificationCommands`만 이어서 마무리한다.

#### 방법 A: Antigravity `/schedule` + `/goal`을 이용한 자동 이어하기
Antigravity 환경에서는 별도 외부 스크립트 없이 내장 슬래시 명령어만으로 Limit 해제 직후 자동 재개를 구성할 수 있다.

1. **초기 실행**: 채팅창에 `/goal`과 함께 아래 방법 C의 **만능 이어하기 프롬프트**를 입력해 작업을 시작한다.
2. **주기적 감시·자동 재개 등록 (`/schedule`)**:
   * 채팅창에 `/schedule` 명령어를 입력하고, 예를 들어 **"매 15분마다(또는 1시간마다) `d:\Noogs\NextCloud\Projects\UnityBrain\PROGRESS.json`을 확인하여 `overallStatus`가 `"completed"`가 아니면 [방법 C의 만능 이어하기 프롬프트]를 즉시 실행하고, `"completed"`이면 스케줄을 종료하라"**고 설정한다.
   * Limit로 대화가 멈추더라도 다음 스케줄 트리거 시 Limit가 풀렸다면 즉시 `PROGRESS.json`의 중단 지점부터 작업을 이어간다.

#### 방법 B: CLI 에이전트용 Limit 감지 & 자동 재시도 래퍼 스크립트 (`tools/auto-resume.ps1`)
Claude Code CLI, Codex CLI, Gemini CLI를 터미널에서 무인 실행할 때, Limit 에러를 감지하면 자동으로 대기했다가 한도가 풀리는 즉시 재호출하는 PowerShell 루프다. 필요 시 `tools/auto-resume.ps1`로 저장해 실행한다.

```powershell
param(
    [ValidateSet("claude", "codex", "gemini")]
    [string]$Agent = "claude",
    [int]$RetryIntervalSeconds = 180,
    [int]$MaxRetries = 200
)

Set-Location "d:\Noogs\NextCloud\Projects\UnityBrain"

$resumePrompt = @"
@AGENTS.md @PROGRESS.json @PLAN.md @docs/AI_EXECUTION_PLAYBOOK.md 를 순서대로 읽어라.
PROGRESS.json에서 status가 'in_progress'이거나 첫 번째 'pending'인 Step을 찾아, completedFiles에 기록된 파일 이후의 미완료 파일부터 중단 없이 이어서 구현하고 verificationCommands 통과 시 Git 체크포인트 커밋 후 다음 Step으로 계속 진행하라. overallStatus가 'completed'가 될 때까지 멈추지 마라.
"@

for ($attempt = 1; $attempt -le $MaxRetries; $attempt++) {
    $progress = Get-Content -Raw -Encoding UTF8 "PROGRESS.json" | ConvertFrom-Json
    if ($progress.overallStatus -eq "completed") {
        Write-Host "[UnityBrain] 모든 Step이 완료되었습니다." -ForegroundColor Green
        break
    }

    Write-Host "[UnityBrain] Attempt #$attempt | Current Step: $($progress.currentStepId) | Agent: $Agent" -ForegroundColor Cyan

    $output = ""
    if ($Agent -eq "claude") {
        $output = (& claude -p $resumePrompt --dangerously-skip-permissions 2>&1 | Out-String)
    } elseif ($Agent -eq "codex") {
        $output = (& codex exec --full-auto $resumePrompt 2>&1 | Out-String)
    } elseif ($Agent -eq "gemini") {
        $output = (& gemini -p $resumePrompt --approval-mode yolo 2>&1 | Out-String)
    }

    $exitCode = $LASTEXITCODE
    Write-Host $output

    $after = Get-Content -Raw -Encoding UTF8 "PROGRESS.json" | ConvertFrom-Json
    if ($after.overallStatus -eq "completed") {
        Write-Host "[UnityBrain] 전체 프로젝트 빌드 및 검증 완료!" -ForegroundColor Green
        break
    }

    # Rate limit / Quota 패턴 또는 비정상 종료 감지 시 쿨다운 대기 후 재시도
    $isRateLimited = $output -match "(?i)(rate.?limit|429|quota|too many requests|limit reached|overloaded|capacity|try again)"
    if ($isRateLimited -or $exitCode -ne 0) {
        $waitSec = $RetryIntervalSeconds
        if ($output -match "(?i)retry.{0,20}?(\d+)\s*(second|sec|s\b)") {
            $waitSec = [Math]::Max([int]$Matches[1] + 5, 30)
        }
        Write-Warning "[UnityBrain] 모델 Limit 또는 중단 감지 (ExitCode=$exitCode). $waitSec 초 대기 후 Step $($after.currentStepId)부터 자동 재개합니다..."
        Start-Sleep -Seconds $waitSec
    } else {
        # 단일 턴 정상 종료되었으나 미완료 Step이 남은 경우 짧은 대기 후 즉시 다음 턴 재개
        Start-Sleep -Seconds 5
    }
}
```

#### 방법 C: 만능 이어하기 프롬프트 (Limit 해제 직후 또는 다른 모델로 교체 시)
모델 Limit가 풀린 직후 새 채팅을 열거나, Claude → Codex / Gemini / ChatGPT 등 **다른 모델로 바톤을 터치**해 이어서 실행할 때 아래 프롬프트를 그대로 복사해 입력한다.

```text
@AGENTS.md @PROGRESS.json @PLAN.md @docs/AI_EXECUTION_PLAYBOOK.md 를 먼저 읽어라.

1. PROGRESS.json에서 status가 "in_progress"이거나 첫 번째 "pending"인 Step을 확인하라.
2. 해당 Step이 이미 "in_progress"라면 completedFiles에 기록된 파일은 기존 코드를 검증만 하고, 아직 완료되지 않은 targetFiles부터 구현을 이어가라.
3. 파일 1개를 완료할 때마다 PROGRESS.json의 completedFiles와 resumeNote를 즉시 갱신하라.
4. 해당 Step의 verificationCommands를 1개씩 실행해 모두 통과하면 status를 "completed"로 바꾸고 로컬 Git 체크포인트 커밋 후, 질문 없이 다음 Step으로 연속 진행하라.
```

---

## 2. AI 도구별 실행 방법 (어디서 어떻게 명령을 내리는가)

사용하는 AI 도구의 형태에 따라 작업 지시 방식이 다르다. 안정성이 최우선일 때는 **Step별 1단계 실행**을, 완전 무인 실행을 원할 때는 **Section 2.3 올인원 자율 실행 프롬프트**를 사용한다.

### 2.1 Case A: 워크스페이스 직결형 에이전트 (추천)
* **해당 도구**: Antigravity, Claude Code CLI, Cursor (Agent 모드), Gemini CLI, Codex CLI, Windsurf
* **어디서 실행하는가**: 반드시 **`d:\Noogs\NextCloud\Projects\UnityBrain`** 폴더를 루트 워크스페이스로 연 상태의 채팅창/터미널에서 실행한다.
* **명령 내리는 방법**:
  1. 아래 섹션 3의 각 Step에서 지정한 참조 파일들을 `@파일경로`로 멘션(또는 프롬프트 내 경로 유지)하고 프롬프트를 그대로 붙여넣는다.
  2. 에이전트가 `AGENTS.md` 규칙에 따라 확인 질문 없이 파일 생성·수정 → `PROGRESS.json` 갱신 → 테스트 실행(`pnpm ...` / `dotnet ...`) → 오류 자가 복구까지 완료하도록 둔다.
  3. **컨텍스트 관리**: Step별 개별 실행 시 Step이 끝날 때마다 대화를 새로 열어 컨텍스트 오염을 막고, 항상 `AGENTS.md`, `PROGRESS.json`, `PLAN.md`, 해당 `docs/plans/0X-*.md`를 다시 읽게 한다.

### 2.2 Case B: 웹 채팅형 AI (로컬 파일 접근 불가)
* **해당 도구**: ChatGPT (웹), Claude.ai (웹), Gemini (웹)
* **어디서 실행하는가**: 웹 브라우저 새 채팅창을 열고, **코드 블록을 전체 출력(생략 금지)** 받아 로컬 파일에 저장한 뒤 로컬 터미널에서 직접 테스트한다.
* **명령 내리는 방법**:
  1. 새 채팅 시작 시 **아래 파일들**을 반드시 첨부(업로드)한다:
     * `AGENTS.md`, `PROGRESS.json` 및 `PLAN.md`
     * 현재 진행할 세부 계획서 `docs/plans/0X-*.md`
     * (Step 1-1 완료 후부터) `packages/extension/src/contracts/index.ts`
  2. 필요 시 `.ref/resharper-unity`의 참조 파일 1~2개도 함께 첨부한다.
  3. 프롬프트 끝에 아래 웹 전용 문구 1줄을 추가해 붙여넣는다:
     > `[웹 채팅 규칙] 로컬 파일 접근 권한이 없으므로, 생성·수정할 각 파일의 정확한 상대 경로 헤더(### File: path)와 함께 생략(// TODO, // ... existing code) 없는 전체 코드를 출력하라.`
  4. AI가 출력한 파일을 로컬에 저장한 뒤, 섹션 3의 **검증 명령어**를 PowerShell에서 직접 실행한다. 에러가 나면 터미널 에러 로그 전체를 복사해 해당 채팅에 붙여넣어 수정시킨다.

### 2.3 전 과정 무중단 올인원 프롬프트 (Phase 단위 또는 전체 원스톱 자율 실행)
사용자가 Step마다 복사·붙여넣기를 반복하지 않고, AI 에이전트(Antigravity `/goal` 등)에게 **한 번의 지시로 특정 Phase 전체 또는 Step 1-1~6-3 전 과정을 중단 없이 완수**시키고 싶을 때 아래 프롬프트를 사용한다.

```text
@AGENTS.md @PROGRESS.json @PLAN.md @docs/AI_EXECUTION_PLAYBOOK.md 를 모두 읽고, [Step 1-1부터 Step 6-3까지 (또는 PROGRESS.json의 현재 미완료 Step부터)]를 중간 중단 없이 순서대로 자율 구현하라.

[무중단 실행 및 체크포인트 규칙]
1. 시작 시 PROGRESS.json을 확인해 status가 "in_progress" 또는 첫 번째 "pending"인 Step부터 시작하라. 이미 completedFiles에 있는 파일은 불필요하게 덮어쓰지 마라.
2. 각 Step을 시작하기 전에 해당 Sub-Plan(`docs/plans/0X-*.md`)을 읽고, 명세된 모든 파일과 심볼을 누락·스텁 없이 완전하게 작성하라. 파일 1개를 완료할 때마다 PROGRESS.json의 completedFiles를 즉시 갱신하라.
3. 사용자에게 "계속할까요?", "어느 옵션을 선택할까요?" 같은 확인 질문을 절대 하지 마라. 모든 구현 선택은 PLAN.md와 Sub-Plan 기준으로 스스로 결정한다.
4. 셸 명령은 반드시 `pnpm ...`, `dotnet ...`, `node ...`, `git ...` 단일 접두사 명령어로 1개씩 실행하라(세미콜론 `;`, `&&`, `$()`, `$VAR` 금지).
5. 각 Step의 완료 확인 명령어(`pnpm ...`, `dotnet ...`)가 100% 통과해야만 PROGRESS.json의 status를 "completed"로 바꾸고 로컬 git commit 체크포인트를 남긴 뒤 다음 Step으로 넘어간다. 실패 시 에러 로그를 분석해 코드를 자가 수정한 뒤 통과할 때까지 재실행하라.
6. 모든 지정된 Step의 빌드·테스트·패키징 검증이 완료되면 `PROGRESS.json`의 overallStatus를 "completed"로 바꾸고 최종 파일 목록과 실제 테스트 결과 요약만 보고하라.
```

---

## 3. 단계별(Phase 1 ~ Phase 6) 실전 실행 시나리오 (총 22 Steps, Step 2-2 선택 포함)

> **명령어 실행 주의**: 아래 모든 `완료 확인 명령어`는 자동 승인(Always Allow) 접두사 매칭을 유지하기 위해 **세미콜론(`;`)이나 체이닝(`&&`) 없이 한 줄에 1개의 단일 명령어**로 분리되어 있다. 에이전트도 동일하게 한 번에 1개 명령어씩 호출한다.

---

### Phase 1: 코어 워크스페이스 & 가상 VFS ([01-core-and-virtual-vfs.md](plans/01-core-and-virtual-vfs.md))

#### Step 1-1: 모노레포 스캐폴딩 & 공유 계약(`contracts`, `schemas`) 생성
* **실행 환경**: `d:\Noogs\NextCloud\Projects\UnityBrain` 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `PLAN.md`, `docs/plans/01-core-and-virtual-vfs.md`
* **입력할 프롬프트**:
```text
AGENTS.md, PLAN.md, docs/plans/01-core-and-virtual-vfs.md를 읽고 Step 1-1을 구현하라.

[작업 범위]
1. 루트 `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `UnityBrain.sln`을 생성하라.
2. PLAN.md §3의 모든 데이터 계약을 `schemas/*.schema.json`(5종)과 `packages/extension/src/contracts/index.ts`로 생성하라. 필드명, 타입, enum 값을 PLAN.md와 1글자도 다르게 만들지 마라.
3. `packages/extension/package.json`, `packages/shader-lsp/package.json`, `tools/api-extractor/package.json`의 기본 의존성(typescript, vitest, fast-xml-parser, vscode-languageserver, vscode-languageclient 등)과 tsconfig를 구성하라.
4. `pnpm install` 실행 후 타입 체크(`pnpm -r exec tsc --noEmit`)를 개별 명령어로 각각 실행해 에러 없이 통과시켜라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어** (1줄씩 개별 실행):
```powershell
pnpm install
pnpm -r exec tsc --noEmit
```

#### Step 1-2: `UnityProjectContextManager` & `UnityVirtualPathResolver` 구현
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `PLAN.md`, `docs/plans/01-core-and-virtual-vfs.md`, `packages/extension/src/contracts/index.ts`, `.ref/resharper-unity/resharper/resharper-unity/src/Unity.Shaders/HlslSupport/Integration/Cpp/UnityCgIncludeDirectoryProvider.cs`
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/01-core-and-virtual-vfs.md §3.1과 §3.2를 구현하라.

[작업 범위]
1. `packages/extension/src/core/unityProjectContext.ts`에 `UnityProjectContextManager`를 구현하라 (`ProjectVersion.txt` 파싱, Win/macOS/Linux Unity Editor 경로 탐색, `unityBrain.unityEditorPath` 설정 우선 적용, manifest/lock 변경 감시).
2. `packages/extension/src/core/virtualPathResolver.ts`와 `packages/shader-lsp/src/vfs/virtualPathResolver.ts`에 `UnityVirtualPathResolver`를 구현하라 (`embedded`, `local`, `registry`, `git`, `builtin`, Unity 6 해시 폴더 `Library/PackageCache/<name>@*`, `Assets/`, `CGIncludes/` 우선순위 및 `listVirtualDirectory()` 포함).
3. `.ref/resharper-unity`의 `UnityCgIncludeDirectoryProvider.cs` 로직을 참조하되 Node.js/TypeScript 비동기 FS API로 깔끔하게 작성하라.
4. `test-fixtures/SampleUnityProject` 픽스처(5종 패키지 소스 및 모의 `CGIncludes`)를 만들고 `vitest` 단위 테스트를 작성 및 실행하여 100% 통과시켜라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어**:
```powershell
pnpm --filter @unitybrain/extension test
```

#### Step 1-3: `tools/api-extractor` 구현 및 `unity-api.json` 생성
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `PLAN.md`, `docs/plans/01-core-and-virtual-vfs.md`, `packages/extension/src/contracts/index.ts`, `.ref/resharper-unity/resharper/resharper-unity/src/Unity/api.xml`
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/01-core-and-virtual-vfs.md §3.3을 구현하라.

[작업 범위]
1. `tools/api-extractor/src/index.ts`에 `extractUnityApiXmlToJson` 함수 및 CLI 진입점을 구현하라.
2. 입력 XML을 파싱해 `UnityApiDatabase` 스키마(`PLAN.md §3.2`)에 맞춘 JSON을 출력하라 (`isPerformanceCritical`, `supportsCoroutine` 플래그 포함).
3. `tools/api-extractor/test/fixtures/sample-api.xml`을 생성해 외부 파일 없이 통과하는 `vitest` 단위 테스트를 작성하라.
4. 실제 `.ref/resharper-unity/resharper/resharper-unity/src/Unity/api.xml`을 입력으로 CLI를 실행하여 `packages/extension/resources/unity-api.json`을 생성하고, 타입 수와 이벤트 함수 수가 정상 추출되었는지 검증하라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어** (1줄씩 개별 실행):
```powershell
pnpm --filter @unitybrain/api-extractor test
node -p "require('fs').existsSync('packages/extension/resources/unity-api.json')"
```

---

### Phase 2: ShaderLab & HLSL Language Server ([02-shaderlab-hlsl-lsp.md](plans/02-shaderlab-hlsl-lsp.md))

#### Step 2-1: ShaderLab 가상 문서 추출기 & Unity HLSL 매크로 전처리 프리패스
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `PLAN.md`, `docs/plans/02-shaderlab-hlsl-lsp.md`, `packages/extension/src/contracts/index.ts`
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/02-shaderlab-hlsl-lsp.md §3.1과 §3.2를 구현하라.

[작업 범위]
1. `packages/shader-lsp/src/parser/shaderLabVirtualDoc.ts`에 `extractVirtualHlslDocument`, `parseShaderProperties`, `parseShaderPragmas`를 구현하라.
   - `HLSLINCLUDE`/`HLSLPROGRAM`/`CGINCLUDE`/`CGPROGRAM` 블록 외부 문자는 `\r`, `\n`을 제외하고 전부 공백(' ')으로 치환(Space Padding)해 원본 `.shader`와 라인·컬럼 오프셋 1:1 일치를 보장하라.
   - 동일 SubShader의 `HLSLINCLUDE` 스코프 연결 및 `Properties` 블록 변수 추출을 구현하라.
2. `packages/shader-lsp/src/parser/unityHlslMacroPrepass.ts`에 `UnityHlslMacroPrepass`를 구현하라 (`TEXTURE2D`, `TEXTURE2D_X`, `SAMPLER`, `CBUFFER_START/END`, `UNITY_INSTANCING_BUFFER_START/END`, `TEXTURE2D_PARAM`, `TEXTURE2D_ARGS` 정규화 및 원본 Span 역매핑).
3. 다중 `Pass`와 `HLSLINCLUDE`가 포함된 테스트 `.shader` 픽스처로 라인·컬럼 오프셋 일치 단위 테스트(`vitest`)를 작성해 통과시켜라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어**:
```powershell
pnpm --filter @unitybrain/shader-lsp test
```

#### Step 2-2 (선택): REA(`morluto/rea`)를 이용한 Rider 셰이더 내장 매크로/스펙 보강
* **실행 환경**: REA MCP가 연결된 에이전트(Claude Code / Cursor / Antigravity)에서 Rider 설치 폴더 접근 가능 시에만 실행 (Rider 미설치 시 건너뜀)
* **입력할 프롬프트**:
```text
AGENTS.md와 PLAN.md §4의 REA 사용 경계를 엄수하라. 코드를 복사하지 말고 Clean-Room 스펙(매크로 이름과 파라미터 형태 목록)만 추출한다.
로컬 Rider 설치 경로 내 `JetBrains.ReSharper.Plugins.Unity.Shaders.dll` 또는 `JetBrains.ReSharper.Psi.Cpp.dll`을 REA 도구로 정적 분석하여 URP/HDRP ShaderLab·HLSL 분석 시 사전 정의되는 Unity 특수 매크로 및 내장 키워드 목록을 추출하고, 누락된 항목만 `packages/shader-lsp/src/parser/unityHlslMacroPrepass.ts`의 매핑 테이블에 추가하라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```

#### Step 2-3: 다단계 `#include` 의존성 그래프 및 Tree-sitter HLSL 심볼 인덱서
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `PLAN.md`, `docs/plans/02-shaderlab-hlsl-lsp.md`, `packages/shader-lsp/src/vfs/virtualPathResolver.ts`, `packages/shader-lsp/src/parser/shaderLabVirtualDoc.ts`, `packages/shader-lsp/src/parser/unityHlslMacroPrepass.ts`
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/02-shaderlab-hlsl-lsp.md §3.3을 구현하라.

[작업 범위]
1. `web-tree-sitter`와 HLSL/CPP WASM 파서를 로드하도록 `packages/shader-lsp/src/indexer/hlslSymbolTable.ts`(`HlslSymbolTable`, `parseHlslSymbols`)를 구현하라.
   - 함수 정의·선언, `struct` 및 멤버 필드, `#define` 상수/함수형 매크로, `cbuffer`/전역 변수, ShaderLab `Properties`를 `HlslSymbolEntry` 스키마로 추출하라.
2. `packages/shader-lsp/src/indexer/hlslIncludeGraph.ts`에 `IncludeDependencyGraph`를 구현하라.
   - `UnityVirtualPathResolver`를 사용해 `#include "..."` 체인을 재귀 탐색(DFS)하되 순환 참조 방지 및 파일 수정 타임스탬프 기반 캐싱을 적용하라.
3. `test-fixtures/SampleUnityProject` 안에 3단계 중첩 폴더 구조(`.shader` -> `Packages/.../Lighting.hlsl` -> `./BRDF.hlsl` -> `../Common/Macros.hlsl`)를 만들고 Include 그래프 및 심볼 테이블 테스트를 통과시켜라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어**:
```powershell
pnpm --filter @unitybrain/shader-lsp test
```

#### Step 2-4: Shader / HLSL `F12` 정의 이동 프로바이더 (`definitionProvider.ts`)
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `docs/plans/02-shaderlab-hlsl-lsp.md`, `packages/shader-lsp/src/indexer/hlslIncludeGraph.ts`, `packages/shader-lsp/src/indexer/hlslSymbolTable.ts`
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/02-shaderlab-hlsl-lsp.md §3.4의 `ShaderDefinitionProvider`를 구현하라.

[작업 범위]
1. `packages/shader-lsp/src/providers/definitionProvider.ts`에 `ShaderDefinitionProvider`를 구현하라.
2. 아래 4가지 이동 케이스를 모두 정확히 처리해야 한다:
   - Case A: `#include "..."` 문자열 위에서 `F12`/`Ctrl+Click` 시 해석된 물리 파일 URI 반환
   - Case B: `#pragma vertex/fragment/kernel <fn>` 위에서 해당 함수 정의 위치 반환
   - Case C: `varName.fieldName` 멤버 접근 시 현재 스코프 변수 선언에서 `varName`의 struct 타입을 추론하고 Include 그래프에서 `struct` 내부 `fieldName` 선언 라인으로 이동
   - Case D: 일반 함수·struct·매크로·`_Property` 식별자 위에서 Include DFS 순서(현재 파일 -> 직접/간접 포함 파일 -> ShaderLab Properties)로 정확한 `Location[]` 반환
3. 3단계 중첩 `.hlsl` 픽스처에서 함수, 구조체 필드, `#include` 경로 이동 단위 테스트를 작성해 통과시켜라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어**:
```powershell
pnpm --filter @unitybrain/shader-lsp test
```

#### Step 2-5: Hover, 자동완성, LSP 서버 본체 및 50ms 성능 검증
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `PLAN.md`, `docs/plans/02-shaderlab-hlsl-lsp.md`, `packages/shader-lsp/src/` 전체
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/02-shaderlab-hlsl-lsp.md §3.4와 §5의 나머지 부분을 구현하라.

[작업 범위]
1. `packages/shader-lsp/src/providers/completionProvider.ts`(`ShaderCompletionProvider`): `#include "` 입력 시 `listVirtualDirectory()` 기반 패키지/폴더/파일 자동완성, `varName.` 입력 시 구조체 멤버 완성, 일반 위치의 함수/구조체/매크로/프로퍼티 완성 구현.
2. `packages/shader-lsp/src/providers/hoverProvider.ts`(`ShaderHoverProvider`): 심볼 시그니처, 구조체 필드, `#define` 치환 내용 및 선언된 가상 경로(`Packages/...`) 표시.
3. `packages/shader-lsp/src/server.ts`(`createShaderLanguageServer`): stdio/IPC LSP 연결, `unityBrain/getShaderPropertyIndex` 커스텀 Request(`ShaderSymbolIndex` 반환), `unityBrain/setShaderKeywords` 커스텀 Notification 처리.
4. 50개 중첩 `#include` 파일을 가진 벤치마크 테스트를 작성해 워밍 후 `DefinitionRequest` 평균 응답 시간이 `< 50ms`임을 검증하라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어**:
```powershell
pnpm --filter @unitybrain/shader-lsp test
```

---

### Phase 3: 도메인 특화 C# 자동완성 ([03-smart-domain-completion.md](plans/03-smart-domain-completion.md))

#### Step 3-1: `ProjectSettingsWatcher` (Unity YAML 설정 감시 및 캐싱)
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `PLAN.md`, `docs/plans/03-smart-domain-completion.md`, `packages/extension/src/contracts/index.ts`
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/03-smart-domain-completion.md §3.1을 구현하라.

[작업 범위]
1. `packages/extension/src/watchers/projectSettingsWatcher.ts`에 `ProjectSettingsWatcher` 클래스를 구현하라.
2. Unity YAML 태그(`%YAML 1.1`, `!u!`, `stripped`)로 파싱 실패하지 않도록 전처리/라인 파서로 아래 파일을 읽어 `ProjectSettingsCache`를 구축하라:
   - `ProjectSettings/TagManager.asset` (기본 태그 7종 병합 + layers + m_SortingLayers)
   - `ProjectSettings/InputManager.asset` (m_Axes.m_Name)
   - `ProjectSettings/EditorBuildSettings.asset` (enabled 씬 목록)
   - `Assets/**/*.controller` (Animator 파라미터 이름/타입 및 State 이름)
3. 변경 감시(300ms debounce) 및 `{projectRoot}/Library/UnityBrainCache/project-settings.json` 원자적 저장을 구현하고, 샘플 `.asset`/`.controller` 픽스처로 Vitest 단위 테스트를 통과시켜라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어**:
```powershell
pnpm --filter @unitybrain/extension test
```

#### Step 3-2: C# 문자열 리터럴 컨텍스트 자동완성 (`UnityStringCompletionProvider`)
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `PLAN.md`, `docs/plans/03-smart-domain-completion.md`, `packages/extension/src/watchers/projectSettingsWatcher.ts`
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/03-smart-domain-completion.md §3.2를 구현하라.

[작업 범위]
1. `packages/extension/src/completion/unityStringCompletionProvider.ts`에 `UnityStringCompletionProvider`를 구현하라.
2. §3.2 매핑표의 모든 C# API 패턴(`CompareTag`, `FindWithTag`, `.tag ==`, `NameToLayer`, `GetMask` 가변인자, `SortingLayer.NameToID`, `Input.GetAxis*`, `GetButton*`, `SceneManager.LoadScene*`, `Shader.PropertyToID`/`Material.Set*`, `Animator.StringToHash`/`animator.Set*`, `Invoke`/`StartCoroutine`)을 인식하는 순수 컨텍스트 감지기(`detectApiStringContext`)를 작성하라.
3. 일반 C# 문자열(`Debug.Log("...")`)에서는 `undefined`를 반환해 기본 C# 자동완성과 충돌하지 않아야 한다.
4. 모든 매핑 패턴과 부정 케이스(일반 문자열)에 대한 Vitest 단위 테스트를 작성해 통과시켜라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어**:
```powershell
pnpm --filter @unitybrain/extension test
```

#### Step 3-3: Unity 이벤트 함수 스니펫 완성 & 일괄 생성 커맨드 (`UnityEventGenerator`)
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `PLAN.md`, `docs/plans/03-smart-domain-completion.md`, `packages/extension/resources/unity-api.json`
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/03-smart-domain-completion.md §3.3을 구현하라.

[작업 범위]
1. `packages/extension/src/completion/unityEventGenerator.ts`에 `UnityEventCompletionProvider`와 `registerGenerateEventFunctionsCommand`를 구현하라.
2. `resources/unity-api.json`을 로드하여 커서가 위치한 C# 클래스의 상속 베이스(`MonoBehaviour`, `ScriptableObject`, `Editor`, `EditorWindow`, `StateMachineBehaviour` 등)에 맞는 미구현 이벤트만 제안하라(이미 클래스 내에 구현된 메서드는 제외).
3. `supportsCoroutine === true`인 이벤트는 `IEnumerator` 반환형 변형도 함께 제공하고, `unityBrain.generateEventFunctions` 커맨드는 QuickPick 다중 선택 후 커서 위치에 포매팅하여 일괄 삽입하라.
4. 클래스 본문 판별, 중복 메서드 필터링, 코루틴 스니펫 생성에 대한 Vitest 단위 테스트를 통과시켜라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어**:
```powershell
pnpm --filter @unitybrain/extension test
```

---

### Phase 4: Roslyn Analyzer & CodeFix ([04-roslyn-analyzers-and-codefixes.md](plans/04-roslyn-analyzers-and-codefixes.md))

#### Step 4-1: Roslyn 프로젝트 스캐폴딩 & `Directory.Build.props` 비침습 주입기
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `PLAN.md`, `docs/plans/04-roslyn-analyzers-and-codefixes.md`
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/04-roslyn-analyzers-and-codefixes.md §1, §2, §3.1을 구현하라.

[작업 범위]
1. `analyzers/UnityBrain.Analyzers/UnityBrain.Analyzers.csproj` (`netstandard2.0`, `Microsoft.CodeAnalysis.CSharp` 4.x, `EnforceExtendedAnalyzerRules=true`)와 `DiagnosticIds.cs` (`UB1001`~`UB4001`)를 생성하라.
2. `analyzers/UnityBrain.Analyzers.Tests/UnityBrain.Analyzers.Tests.csproj` (`xUnit`, `Microsoft.CodeAnalysis.CSharp.Analyzer.Testing.XUnit`, `Microsoft.CodeAnalysis.CSharp.CodeFix.Testing.XUnit`)를 구성하고 `UnityBrain.sln`에 등록하라.
3. `packages/extension/src/analyzers/msbuildInjector.ts`에 `MsbuildAnalyzerInjector`를 구현하라. `.csproj`는 절대 수정하지 말고 `{projectRoot}/Directory.Build.props`의 `<!-- UnityBrain:Begin --> ... <!-- UnityBrain:End -->` 블록만 idempotent하게 삽입·갱신·제거해야 한다.
4. `dotnet build`와 `msbuildInjector.ts`의 Vitest 단위 테스트(기존 사용자 `Directory.Build.props` 내용 보존 검증)를 개별 명령어로 각각 실행해 통과시켜라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어** (1줄씩 개별 실행):
```powershell
dotnet build analyzers/UnityBrain.Analyzers/UnityBrain.Analyzers.csproj
pnpm --filter @unitybrain/extension test
```

#### Step 4-2: 콜그래프 성능 분석 (`UB1001`, `UB1002`) + `Awake()` 자동 캐싱 Quick-Fix
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `PLAN.md`, `docs/plans/04-roslyn-analyzers-and-codefixes.md`, `.ref/resharper-unity/resharper/resharper-unity/src/Unity/CSharp/Daemon/Stages/PerformanceCriticalCodeAnalysis/`
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/04-roslyn-analyzers-and-codefixes.md §3.2를 구현하라.
주의: Microsoft.Unity.Analyzers(UNT0001~UNT0038)는 중복 구현하지 마라.

[작업 범위]
1. `analyzers/UnityBrain.Analyzers/CallGraph/PerformanceCriticalContextAnalyzer.cs`를 구현하라.
   - `AdditionalFiles`의 `unity-api.json` 또는 기본 성능 임계 이벤트(`Update`, `FixedUpdate`, `LateUpdate`, `OnGUI` 등)와 코루틴 루프에서 출발하는 클래스 내 Call Graph를 구축하라(순환 호출 방지).
   - `UB1001`: 헬퍼 메서드를 거친 간접 고비용 호출(`GetComponent*`, `Find*`, `Camera.main`, `Resources.Load*`, `new WaitForSeconds`)을 루트 경로와 함께 진단.
   - `UB1002`: 성능 문맥 내 반복 `GetComponent<T>()` / `TryGetComponent<T>(out ...)` 진단.
2. `analyzers/UnityBrain.Analyzers/CodeFixes/CacheComponentInAwakeCodeFixProvider.cs`를 구현하라 (`private T _cachedT;` 필드 생성 + 기존 `Awake()` 첫 줄 또는 새 `Awake()` 생성 후 호출 치환).
3. 3단계 헬퍼 호출 체인(`Update -> StepA -> StepB -> GetComponent<Rigidbody>`) 진단 및 CodeFix 결과 코드 검증 xUnit 테스트를 작성하고 `dotnet test`를 통과시켜라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어**:
```powershell
dotnet test analyzers/UnityBrain.Analyzers.Tests/UnityBrain.Analyzers.Tests.csproj --filter "FullyQualifiedName~PerformanceCritical"
```

#### Step 4-3: 문자열 ID 캐싱 (`UB1003`) + `Shader.PropertyToID`/`Animator.StringToHash` Quick-Fix
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `docs/plans/04-roslyn-analyzers-and-codefixes.md`, `analyzers/UnityBrain.Analyzers/CallGraph/PerformanceCriticalContextAnalyzer.cs`
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/04-roslyn-analyzers-and-codefixes.md §3.3을 구현하라.

[작업 범위]
1. `analyzers/UnityBrain.Analyzers/Diagnostics/UncachedShaderOrAnimatorIdAnalyzer.cs` (`UB1003`): `Material.Set*/Get*/HasProperty`, `Shader.SetGlobal*`, `Animator.Set*/Get*/ResetTrigger`에서 문자열 리터럴이 성능 문맥 내 호출되거나 클래스 내 2회 이상 사용될 때 경고하라.
2. `analyzers/UnityBrain.Analyzers/CodeFixes/ExtractPropertyToIdCodeFixProvider.cs`: 클래스 상단에 `private static readonly int ...Id = Shader.PropertyToID("...");` 또는 `Animator.StringToHash("...")` 정적 필드를 추출(기존 동일 필드 존재 시 재사용)하고 문자열 인자를 치환하라.
3. Analyzer + CodeFix xUnit 테스트를 작성해 통과시켜라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어**:
```powershell
dotnet test analyzers/UnityBrain.Analyzers.Tests/UnityBrain.Analyzers.Tests.csproj --filter "FullyQualifiedName~ShaderOrAnimator"
```

#### Step 4-4: Burst Compiler 정적 검증기 (`UB2001`~`UB2004`)
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `docs/plans/04-roslyn-analyzers-and-codefixes.md`, `.ref/resharper-unity/resharper/resharper-unity/src/Unity/CSharp/Daemon/Stages/BurstCodeAnalysis/`
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/04-roslyn-analyzers-and-codefixes.md §3.4를 구현하라.

[작업 범위]
1. `analyzers/UnityBrain.Analyzers/Diagnostics/BurstCompileAnalyzer.cs`를 구현하라 (`[BurstCompile]`이 붙은 struct 또는 static 메서드 내부 `IOperation` 검사, `[BurstDiscard]` 메서드 내부는 제외).
   - `UB2001`: 관리되는 참조 타입(class) 생성/필드 접근 금지
   - `UB2002`: 값 타입의 object/인터페이스 Boxing 금지
   - `UB2003`: 문자열 연결/보간/`string.Format` 금지 (`FixedString*` 및 `Debug.Log` 상수 리터럴 예외)
   - `UB2004`: `try-catch` 및 관리되는 예외 `throw` 금지
2. 각 `UB2001`~`UB2004` 및 `[BurstDiscard]` 예외 케이스에 대한 xUnit 테스트를 작성해 `dotnet test`를 통과시켜라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어**:
```powershell
dotnet test analyzers/UnityBrain.Analyzers.Tests/UnityBrain.Analyzers.Tests.csproj --filter "FullyQualifiedName~BurstCompile"
```

#### Step 4-5: 문자열 정합성 검사 (`UB3001`~`UB3003`) & `[FormerlySerializedAs]` 리팩토링 (`UB4001`)
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `PLAN.md`, `docs/plans/04-roslyn-analyzers-and-codefixes.md`
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/04-roslyn-analyzers-and-codefixes.md §3.5와 §3.6을 구현하라.

[작업 범위]
1. `analyzers/UnityBrain.Analyzers/Diagnostics/UnityStringValidationAnalyzer.cs`:
   - `UB3001`: `Invoke`/`StartCoroutine` 문자열 리터럴이 현재/상속 클래스에 없거나 `StartCoroutine` 대상 반환형이 `IEnumerator`가 아닌 경우 경고.
   - `UB3002`: `AdditionalFiles`의 `project-settings.json`을 읽어 `CompareTag`/`FindWithTag`/`NameToLayer`/`GetMask`의 존재하지 않는 Tag/Layer 경고 (`project-settings.json` 부재 시 침묵).
   - `UB3003`: `SceneManager.LoadScene*` 인자가 `buildScenes`에 없을 때 경고.
2. `analyzers/UnityBrain.Analyzers/CodeFixes/FormerlySerializedAsRefactoringProvider.cs` (`UB4001`): `[SerializeField]` 또는 직렬화 가능 `public` 필드에서 "Add [FormerlySerializedAs]" / 안전 리팩토링 액션을 제공하라.
3. 전체 `UnityBrain.Analyzers.Tests`를 실행해 모든 `UB` 테스트가 Pass하는지 검증하라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어**:
```powershell
dotnet test analyzers/UnityBrain.Analyzers.Tests/UnityBrain.Analyzers.Tests.csproj
```

---

### Phase 5: .NET 8 YAML 에셋 인덱서 & CodeLens ([05-yaml-asset-indexer-and-codelens.md](plans/05-yaml-asset-indexer-and-codelens.md))

#### Step 5-1: `MetaGuidMap` & 무할당 `UnityYamlStreamParser` 구현
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `PLAN.md`, `docs/plans/05-yaml-asset-indexer-and-codelens.md`
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/05-yaml-asset-indexer-and-codelens.md §3.1과 §3.2를 구현하라.

[작업 범위]
1. `packages/unity-daemon/UnityBrain.Daemon.csproj` (.NET 8) 및 테스트 프로젝트 `packages/unity-daemon/UnityBrain.Daemon.Tests/UnityBrain.Daemon.Tests.csproj`를 생성하고 `UnityBrain.sln`에 등록하라.
2. `Indexing/MetaGuidMap.cs`: `Assets/` 및 로컬 `Packages/`의 `*.meta` 파일을 병렬 스캔해 GUID <-> 스크립트 경로 양방향 맵을 구축하라.
3. `Indexing/UnityYamlStreamParser.cs`: 범용 YAML DOM 파서(YamlDotNet 등)를 쓰지 말고 `StreamReader` + `ReadOnlySpan<char>` 라인 상태 머신으로 1-Pass 스캔하라.
   - `!u!1`(GameObject), `!u!4`/`!u!224`(Transform/RectTransform 계층 경로 조립), `!u!114`(MonoBehaviour `m_Script` GUID, 사용자 직렬화 스칼라 필드, `m_PersistentCalls` UnityEvent `m_Target`+`m_MethodName`), `!u!1001`(PrefabInstance 오버라이드)을 추출하라.
4. 계층 경로(`Parent/Child/Leaf`), 스칼라 값, UnityEvent 콜백 추출 정확도를 검증하는 xUnit 테스트를 통과시켜라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어**:
```powershell
dotnet test packages/unity-daemon/UnityBrain.Daemon.Tests/UnityBrain.Daemon.Tests.csproj
```

#### Step 5-2: 바이너리 증분 캐시 & JSON-RPC 서버 + 1,000개 에셋 `< 500ms` 벤치마크
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `PLAN.md`, `docs/plans/05-yaml-asset-indexer-and-codelens.md`, `packages/unity-daemon/Indexing/UnityYamlStreamParser.cs`
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/05-yaml-asset-indexer-and-codelens.md §3.3과 §4를 구현하라.

[작업 범위]
1. `packages/unity-daemon/Cache/BinaryIndexCache.cs`: `{cacheDir}/asset-index.bin` (Magic "UBIX", 파일별 LastWriteUtc+Length 매니페스트 및 인덱스 레코드) 저장·복원 및 증분 재파싱을 구현하라.
2. `packages/unity-daemon/RpcServer.cs`와 `Program.cs`: `PLAN.md §3.5`의 모든 JSON-RPC 2.0 메서드(`index/status`, `index/rebuild`, `usage/findByScriptGuid`, `usage/findByMethod`, `inspector/getSerializedValues`)와 `notification/indexProgress`를 stdio로 처리하라.
3. xUnit 테스트에 합성 `.prefab`/`.unity` 파일 1,000개를 생성해 풀 인덱싱 `< 500ms`, 1개 파일 수정 후 웜 스타트 `< 150ms`, stdio JSON-RPC 요청/응답을 검증하고 통과시켜라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어**:
```powershell
dotnet test packages/unity-daemon/UnityBrain.Daemon.Tests/UnityBrain.Daemon.Tests.csproj
```

#### Step 5-3: VS Code `UnityDaemonClient` & `UnityAssetUsageCodeLensProvider` 구현
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `PLAN.md`, `docs/plans/05-yaml-asset-indexer-and-codelens.md`, `packages/extension/src/contracts/index.ts`
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/05-yaml-asset-indexer-and-codelens.md §3.4를 구현하라.

[작업 범위]
1. `packages/extension/src/codelens/unityAssetUsageCodeLensProvider.ts`에 `UnityDaemonClient`(자식 프로세스 spawn, `vscode-jsonrpc` stdio 통신, 비정상 종료 시 최대 3회 지수 백오프 재시작)와 `UnityAssetUsageCodeLensProvider`를 구현하라.
2. C# 클래스 선언 위(`N Asset Usages (X Scenes, Y Prefabs)`), `[SerializeField]`/`public` 필드 위(`Inspector: 값` 또는 `N Prefab Values...`), 콜백 메서드 위(`M UnityEvent Usages`)에 CodeLens를 제공하고, 클릭 시 QuickPick 목록 및 해당 에셋 `fileID` 라인으로 열기 커맨드(`unityBrain.showAssetUsages`)를 연결하라.
3. 목 JSON-RPC 스트림을 이용한 Vitest 단위 테스트를 작성해 통과시켜라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어**:
```powershell
pnpm --filter @unitybrain/extension test
```

---

### Phase 6: `.meta` 동기화, 셰이더 상태바 & VSIX 패키징 ([06-meta-sync-and-integration.md](plans/06-meta-sync-and-integration.md))

#### Step 6-1: `.meta` 파일 생명주기 동기화 (`MetaFileSyncManager`)
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `PLAN.md`, `docs/plans/06-meta-sync-and-integration.md`
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/06-meta-sync-and-integration.md §3.1을 구현하라.

[작업 범위]
1. `packages/extension/src/meta/metaFileSyncManager.ts`에 `MetaFileSyncManager`를 구현하라.
2. `Assets/` 및 `Packages/` 내부 파일·폴더에 대해:
   - `onWillRenameFiles`: `{oldPath}.meta`가 존재하면 GUID를 변경하지 않고 `{newPath}.meta`로 이동(`WorkspaceEdit`)
   - `onWillDeleteFiles`: `{path}.meta` 함께 삭제
   - `onDidCreateFiles`: 150ms 대기 후 `.meta`가 없으면 Unity 표준 포맷(`.cs` -> MonoImporter, 폴더 -> `folderAsset: yes`, 기타 -> DefaultImporter/ShaderImporter, 32자리 hex GUID)으로 생성
   - `unityBrain.cleanOrphanMetaFiles` 고아 `.meta` 정리 커맨드 구현
3. 이름 변경 GUID 보존, 삭제, 중복 생성 방지, 고아 스캔 Vitest 단위 테스트를 통과시켜라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어**:
```powershell
pnpm --filter @unitybrain/extension test
```

#### Step 6-2: Shader Keyword Context Status Bar & Variant Count CodeLens
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `PLAN.md`, `docs/plans/06-meta-sync-and-integration.md`, `packages/shader-lsp/src/server.ts`
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/06-meta-sync-and-integration.md §3.2를 구현하라.

[작업 범위]
1. `packages/extension/src/shader/shaderKeywordContextStatusBar.ts`에 `ShaderKeywordContextStatusBar`와 `ShaderVariantCodeLensProvider`를 구현하라.
2. 활성 `.shader`/`.hlsl` 파일의 `#pragma multi_compile*` 및 `#pragma shader_feature*` 지시문을 파싱해 전체 조합 수(Variant Count)를 계산하고 Pass/HLSLPROGRAM 상단에 CodeLens를 표시하라.
3. Status Bar 클릭(`unityBrain.selectShaderKeywords`) 시 QuickPick 다중 선택으로 키워드를 토글하고 결과를 `shader-lsp`의 `unityBrain/setShaderKeywords` Notification으로 전송하라.
4. 조합 수 계산(`_`, 다중 그룹 곱셈) 및 키워드 파싱 Vitest 단위 테스트를 통과시켜라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어**:
```powershell
pnpm --filter @unitybrain/extension test
```

#### Step 6-3: 최종 통합 (`extension.ts`, `package.json`), E2E 테스트 & `.vsix` 패키징
* **실행 환경**: 워크스페이스 (새 채팅)
* **참조 시킬 파일**: `AGENTS.md`, `PLAN.md`, `docs/plans/06-meta-sync-and-integration.md`, 전체 모듈 파일
* **입력할 프롬프트**:
```text
AGENTS.md와 docs/plans/06-meta-sync-and-integration.md §3.3, §3.4, §3.5 및 §4를 구현하라.

[작업 범위]
1. `packages/extension/package.json`을 §3.3 규약대로 완성하라 (`extensionDependencies: ["ms-dotnettools.csharp", "visualstudiotoolsforunity.vstuc"]`, languages, commands, configuration, activationEvents).
2. `packages/extension/syntaxes/unity-shaderlab.tmLanguage.json`을 작성하라.
3. `packages/extension/src/extension.ts`에 §3.4 활성화 순서(Context -> MsbuildInjector -> ProjectSettingsWatcher -> ShaderLanguageClient -> UnityDaemonClient -> Providers -> MetaSync -> StatusBar) 및 안전한 `deactivate()` 종료 처리를 구현하라.
4. 루트 `package.json`에 `build:analyzers`, `build:daemon`, `build:lsp`, `build:extension`, `package:vsix` 통합 빌드 스크립트를 구성하라.
5. `@vscode/test-electron` E2E 테스트를 작성하고 아래 7개 빌드·테스트·패키징 명령어를 1개씩 실행해 `.vsix` 내부 산출물(extension.js, shader-lsp, UnityBrain.Analyzers.dll, UnityBrain.Daemon, unity-api.json, .wasm)이 모두 포함되었는지 검증하라.

[자율 실행 규칙] AGENTS.md를 준수하여 중간 질문·확인 요청 없이 구현과 테스트 통과까지 자율적으로 완료하라.
```
* **완료 확인 명령어** (1줄씩 개별 실행):
```powershell
pnpm run build:analyzers
pnpm run build:daemon
pnpm run build:lsp
pnpm run build:extension
pnpm -r test
dotnet test UnityBrain.sln
pnpm run package:vsix
```

---

## 4. AI가 잘못된 방향으로 갈 때 사용하는 교정 프롬프트 (복구 치트시트)

작업 도중 AI가 아래와 같은 실수를 하면 즉시 중단시키고 해당 교정 프롬프트를 입력한다.

### Case 1: 코드를 `// TODO`나 `// ... existing code`로 생략했을 때
```text
방금 작성한 코드에 미구현 스텁(TODO / placeholder / throw new Error('Not implemented') / 생략 주석)이 포함되어 있다. 생략 없이 즉시 컴파일되고 테스트를 통과하는 완전한 실제 구현 코드로 다시 작성하고 테스트를 재실행하라.
```

### Case 2: `PLAN.md`의 공유 스키마와 다른 필드명·경로를 임의로 만들었을 때
```text
PLAN.md §3의 공유 계약 및 `packages/extension/src/contracts/index.ts`와 필드명/경로가 일치하지 않는다. 임의로 변경한 타입이나 경로를 모두 `PLAN.md` 기준으로 즉시 되돌리고, 관련 파일들의 import와 테스트를 다시 맞춰라.
```

### Case 3: AI가 `.csproj`를 직접 수정하거나 `UNT0001`~`UNT0038`을 중복 구현하려 할 때
```text
PLAN.md §1.3과 §4 규칙 위반이다.
1) `.csproj` 파일은 Unity가 덮어쓰므로 절대 수정하지 말고 `Directory.Build.props`의 마커 블록만 사용하라.
2) `Microsoft.Unity.Analyzers`(`UNTxxxx`, `USPxxxx`)는 `vstuc`가 이미 제공하므로 중복 구현하지 말고 `docs/plans/04-roslyn-analyzers-and-codefixes.md`에 명시된 `UB1xxx`~`UB4xxx` 규칙만 구현하라.
위 원칙에 맞춰 코드를 수정하라.
```

### Case 4: 테스트가 실패했는데 AI가 테스트 assertions를 완화하거나 skip하려 할 때
```text
테스트 기대값이나 assertion을 완화·삭제·skip하지 마라. 실패 원인은 구현 코드에 있다. 에러 로그의 스택 트레이스를 분석해 프로덕션 코드의 버그를 수정한 뒤, 원래 테스트가 100% 통과한 결과만 보고하라.
```
