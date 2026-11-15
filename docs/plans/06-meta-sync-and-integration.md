# Sub-Plan 06: `.meta` File Sync, Shader Variant Switcher & VSIX Integration

> **상위 마스터 문서**: [../../PLAN.md](../../PLAN.md)  
> **예상 기간**: Week 12 (Phase 6 — 최종 통합 및 배포 파이프라인)  
> **선행 조건**: Sub-Plan 01 ~ 05 전체 완료

---

## 1. 목적 및 목표 (Purpose & Goal)

### 1.1 목적
VS Code에서 Unity 에셋/스크립트 파일을 생성·이름변경·삭제할 때 `.meta` 파일이 누락되거나 짝을 잃어 Unity GUID 참조(Scene/Prefab 연결)가 깨지는 치명적인 문제를 방지한다. 또한 셰이더 멀티컴파일 키워드 컨텍스트 전환 UI를 제공하고, 지금까지 구현한 모든 모듈(`extension`, `shader-lsp`, `unity-daemon`, `UnityBrain.Analyzers`, `unity-api.json`)을 **단 하나의 `.vsix` 확장 패키지**로 통합·검증한다.

### 1.2 목표
1. `Assets/` 및 로컬 `Packages/` 내부 파일·폴더의 생성/이동/이름변경/삭제 시 `.meta` 파일을 원자적으로 동기화하는 `MetaFileSyncManager` 구현.
2. `.shader` / `.hlsl` 편집 중 `#pragma multi_compile` / `#pragma shader_feature` 변형(Variant) 수를 CodeLens로 표시하고, Status Bar에서 활성 키워드를 전환해 `shader-lsp`의 전처리기 컨텍스트에 즉시 반영하는 `ShaderKeywordContextStatusBar` 구현.
3. `ms-dotnettools.csharp`와 `visualstudiotoolsforunity.vstuc`를 `extensionDependencies`로 선언한 최종 `packages/extension/package.json` 및 통합 진입점 `extension.ts` 완성.
4. Windows/macOS/Linux 크로스 플랫폼 `.vsix` 번들링 스크립트 및 `@vscode/test-electron` E2E 검증 통과.

---

## 2. 생성할 파일 및 심볼 명세

| 파일 경로 | 핵심 Export / 파일 항목 | 역할 |
| :--- | :--- | :--- |
| `packages/extension/src/meta/metaFileSyncManager.ts` | `MetaFileSyncManager` | VS Code 파일 생명주기 훅을 통한 `.meta` 파일 자동 생성·이동·삭제 |
| `packages/extension/src/shader/shaderKeywordContextStatusBar.ts` | `ShaderKeywordContextStatusBar`, `ShaderVariantCodeLensProvider` | `#pragma multi_compile`/`shader_feature` 변형 수 표시 및 활성 키워드 상태바 전환 |
| `packages/extension/src/extension.ts` | `activate`, `deactivate` | 전 모듈 오케스트레이션 (Context → Injector → Shader LSP → Daemon → Completion → CodeLens → Meta Sync) |
| `packages/extension/package.json` | Extension Manifest | 의존 확장, 언어 ID(`.shader`, `.hlsl`, `.cginc`, `.compute`, `.urtshader`), 커맨드, 설정 스키마 |
| `packages/extension/syntaxes/unity-shaderlab.tmLanguage.json` | TextMate Grammar (보강) | `vstuc` 기본 문법이 비활성화되었거나 `.urtshader`/`.compute`/`.hlsl` 확장자 보완용 문법 |

---

## 3. 세부 구현 알고리즘 및 기술 설계

### 3.1 `.meta` 파일 생명주기 동기화 (`metaFileSyncManager.ts`)
1. **적용 범위**:
   * `UnityProjectContext.projectRoot` 내 `Assets/**` 및 `Packages/**` (단, `Library/`, `Temp/`, `Obj/`, `.git/`, `*.meta` 자체는 제외).
2. **이벤트 훅 (VS Code `workspace` API)**:
   * **`workspace.onWillRenameFiles` (`event.waitUntil`)**:
     * 파일 또는 **폴더** 이름 변경/이동 시 `{oldPath}.meta`가 존재하면 `WorkspaceEdit` (`renameFile`)을 추가해 `{newPath}.meta`로 함께 이동한다.
     * **주의**: 기존 `.meta` 내부의 `guid:` 값을 절대 수정하지 않고 파일명만 이동시켜 Scene/Prefab의 GUID 참조가 100% 유지되게 한다.
   * **`workspace.onWillDeleteFiles` (`event.waitUntil`)**:
     * 파일 또는 폴더 삭제 시 대응하는 `{path}.meta`도 `WorkspaceEdit.deleteFile`로 함께 삭제한다(휴지통 옵션 `useTrash` 상속).
   * **`workspace.onDidCreateFiles`**:
     * 새 파일/폴더 생성 시 대응하는 `.meta`가 없으면 Unity 표준 포맷으로 즉시 생성할 수 있도록 옵션(`unityBrain.meta.autoGenerateOnCreate`, 기본값 `true`) 제공:
       * `guid`: `crypto.randomBytes(16).toString('hex')` (32자리 소문자 hex)
       * `.cs` 파일 → `MonoImporter` 기본 헤더 템플릿
       * 폴더 → `folderAsset: yes` + `DefaultImporter` 템플릿
       * 기타 에셋(`.shader`, `.hlsl` 등) → `ShaderImporter` / `DefaultImporter` 템플릿
     * 주의: Unity Editor가 이미 실행 중이어서 동시에 `.meta`를 생성하는 경합을 막기 위해 `150ms` 대기 후 `fs.existsSync(metaPath)`를 재확인하고 없을 때만 작성한다.
3. **고아 `.meta` (Orphan Meta) 검사 커맨드**:
   * `unityBrain.cleanOrphanMetaFiles`: 원본 파일 없이 홀로 남은 `.meta`를 스캔해 사용자 확인 후 일괄 정리.

### 3.2 Shader Keyword Context Status Bar (`shaderKeywordContextStatusBar.ts`)
1. **지시문 파싱**:
   * 활성 `.shader` 또는 `.hlsl` 파일의 `#pragma multi_compile(_local)? ...` 및 `#pragma shader_feature(_local)? ...` 라인을 스캔한다.
   * 각 라인의 키워드 그룹(공백 구분, `_`는 비활성 변형 포함)을 추출해 전체 조합 수(`Π group.length`)를 계산한다.
2. **Variant Count CodeLens (`ShaderVariantCodeLensProvider`)**:
   * `.shader`의 각 `Pass` 또는 `HLSLPROGRAM` 시작 라인 상단에 `Shader Variants: {count} ({groupCount} keyword groups)` CodeLens를 표시한다.
3. **상태바 UI & 키워드 토글**:
   * 셰이더 파일 편집 시 하단 Status Bar에 `$(symbol-keyword) Shader Keywords ({activeCount})` 항목 노출.
   * 클릭 시 QuickPick Multi-Select로 `#pragma`에서 수집된 키워드(예: `_MAIN_LIGHT_SHADOWS`, `_SHADOWS_SOFT`, `_ALPHATEST_ON`)를 켜고 끌 수 있으며, 선택 결과를 `shader-lsp`의 커스텀 notification `unityBrain/setShaderKeywords`로 전송해 `#ifdef` / `#if defined(...)` 분기 평가 및 비활성 블록 음영/Hover에 반영한다.

### 3.3 `packages/extension/package.json` 핵심 매니페스트 규약
* **`extensionDependencies`**:
  ```json
  [
    "ms-dotnettools.csharp",
    "visualstudiotoolsforunity.vstuc"
  ]
  ```
* **`activationEvents`**:
  * `workspaceContains:**/ProjectSettings/ProjectVersion.txt`
  * `onLanguage:hlsl`
  * `onLanguage:shaderlab`
  * `onLanguage:csharp`
* **`contributes.languages`**:
  * `shaderlab`: `.shader`
  * `hlsl`: `.hlsl`, `.cginc`, `.compute`, `.hlslinc`, `.urtshader`
* **`contributes.commands`**:
  * `unityBrain.generateEventFunctions` ("UnityBrain: Generate Unity Event Functions...")
  * `unityBrain.showAssetUsages` ("UnityBrain: Show Asset Usages")
  * `unityBrain.rebuildAssetIndex` ("UnityBrain: Rebuild Asset Index")
  * `unityBrain.cleanOrphanMetaFiles` ("UnityBrain: Clean Orphan .meta Files")
  * `unityBrain.selectShaderKeywords` ("UnityBrain: Select Active Shader Keywords")
* **`contributes.configuration`**:
  * `unityBrain.unityEditorPath` (string)
  * `unityBrain.analyzers.enabled` (boolean, default `true`)
  * `unityBrain.completion.showEventSnippets` (boolean, default `true`)
  * `unityBrain.codelens.assetUsages` (boolean, default `true`)
  * `unityBrain.meta.syncEnabled` (boolean, default `true`)
  * `unityBrain.meta.autoGenerateOnCreate` (boolean, default `true`)

### 3.4 통합 진입점 (`packages/extension/src/extension.ts`) 활성화 순서
1. `UnityProjectContextManager.initialize()` 실행 — Unity 프로젝트가 아니면 조용히 대기 상태로 종료(비-Unity 워크스페이스 오버헤드 0).
2. `MsbuildAnalyzerInjector.ensureInjected()` 실행 — `Directory.Build.props` 갱신.
3. `ProjectSettingsWatcher.start()` 실행 — 최초 `project-settings.json` 생성.
4. `ShaderLanguageClient` 시작 — `packages/shader-lsp` 연결 및 `UnityProjectContext` 전달.
5. `UnityDaemonClient.start()` 실행 — `packages/unity-daemon` 백그라운드 구동.
6. 프로바이더 및 매니저 등록 (`UnityStringCompletionProvider`, `UnityEventCompletionProvider`, `UnityAssetUsageCodeLensProvider`, `MetaFileSyncManager`, `ShaderKeywordContextStatusBar`).
7. `context.subscriptions`에 모든 `Disposable` 등록하여 `deactivate()` 시 자식 프로세스(`shader-lsp`, `unity-daemon`) 누수 없이 안전 종료 보장.

### 3.5 통합 빌드 및 패키징 스크립트 (루트 `package.json`)
* `build:analyzers`: `dotnet build analyzers/UnityBrain.Analyzers/UnityBrain.Analyzers.csproj -c Release` → `packages/extension/analyzers/`로 `.dll` 복사.
* `build:daemon`: `dotnet publish packages/unity-daemon/UnityBrain.Daemon.csproj -c Release` (타깃 OS별 또는 Framework-dependent `.NET 8` 번들) → `packages/extension/bin/daemon/` 복사.
* `build:lsp`: `packages/shader-lsp` esbuild/tsc 번들 (`tree-sitter.wasm` 및 `tree-sitter-hlsl.wasm` 포함) → `packages/extension/dist/shader-lsp/`.
* `build:extension`: `packages/extension` esbuild 번들 → `packages/extension/dist/extension.js`.
* `package:vsix`: `npx @vscode/vsce package` 실행하여 단일 `.vsix` 산출물 생성.

---

## 4. 검증 기준 및 완료 조건 (Verification & Definition of Done)

모든 AI 구현 작업의 최종 게이트로서 아래 통합 검증이 모두 통과해야 한다.

1. **`.meta` 동기화 단위 테스트**:
   * 파일/폴더 이름 변경 시 `.meta` 파일이 동일 GUID를 유지한 채 함께 이동하는지, 삭제 시 함께 삭제되는지, 생성 시 중복 생성 없이 유효한 32자 hex GUID `.meta`가 생성되는지 검증.
2. **Shader Variant 파서 테스트**:
   * 다수의 `#pragma multi_compile` / `#pragma shader_feature` 라인에서 정확한 조합 수(Variant Count)를 산출하는지 검증.
3. **E2E VS Code 통합 테스트 (`@vscode/test-electron`)**:
   * `test-fixtures/SampleUnityProject`를 헤드리스 VS Code 인스턴스로 열어:
     1. Extension 활성화 및 `Directory.Build.props` 자동 생성 확인
     2. `.shader` 파일 내 `#include "Packages/..."` 및 HLSL 심볼에 `vscode.executeDefinitionProvider` 실행 시 실제 패키지 캐시 파일의 정확한 위치 반환 확인
     3. `.cs` 파일 내 `CompareTag("")` 위치에서 `vscode.executeCompletionItemProvider` 실행 시 `TagManager.asset`의 태그 반환 확인
     4. `.cs` 파일 클래스 상단에 `vscode.executeCodeLensProvider` 실행 시 `Asset Usages` CodeLens 반환 확인
4. **패키징 검증**:
   * `pnpm run package:vsix` 실행 시 오류 없이 `.vsix` 파일이 생성되고, 내부에 `extension.js`, `shader-lsp`, `UnityBrain.Analyzers.dll`, `UnityBrain.Daemon`, `unity-api.json`, `.wasm` 파일이 모두 포함되었는지 아카이브 목록 검사로 확인.
