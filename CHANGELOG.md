# Changelog

All notable changes to the **UnitySense** extension will be documented in this file.

## [1.1.6] - 2026-11-21

### Fixed
- **Shader Rename / `.hlsl` 형제 셰이더 / UTF-16 오프셋 / 전처리기 정확도 개선**:
  - `ShaderRenameProvider`가 `.uv`/`.r`/`.x` 같은 구조체 필드 이름 변경을 벡터 스위즐로 오인해 차단하던 문제를 수정(`isVectorSwizzleToken` 체인 해석 기반 판별 및 `uv` 제외)했습니다.
  - `stripCommentsAndStringsByLine`, `ShaderDocumentSymbolProvider`, `maskShaderLabTriviaAndBlocks`의 잔여 `Array.from()`을 UTF-16 코드유닛 기준(`split('')`)으로 통일해 이모지/비-BMP 문자 뒤 컬럼 밀림을 제거했습니다.
  - `.shader`에서 `#include`된 `.hlsl` 심볼·필드를 References/Rename할 때 동일 헤더를 포함하는 형제 `.shader` 파일까지 함께 탐색·수정하며, 멀티패스 셰이더가 타 Pass struct 대신 `#include` 헤더의 struct를 우선 해석하도록 보완했습니다.
  - `#if 0` 블록 및 `#define FOO 0` 값을 구분해 비활성 분기 Dimming 오작동을 제거했고, `cbuffer Foo {` 선언의 실제 식별자 컬럼을 기록합니다.
- **C# 11 문자열 마스킹 및 `Awake()` 캐싱 Quick-Fix 엣지케이스 일괄 수정**:
  - `maskCSharpCommentsAndStrings`가 C# 11 raw string(`"""..."""`), `@$"..."` / `$@"..."`, 중첩 `$"..."` 보간식 내부 문자열/문자리터럴까지 안전하게 마스킹하고, `UnityEventCompletionProvider` 스페이스 트리거 허용 키워드(`bool`, `float`, `int`, `internal`, `virtual`, `new`)를 보강했습니다.
  - `UnityCSharpCodeActionProvider`가 식 본문 `Awake() => ...;`, 주석/문자열 내 `{}` 중괄호, `/* */` 및 문자열 안 `Camera.main` 오탐, 같은 줄 다중 `Camera.main`, `Awake()` 내부 자기참조 방지, `this.gameObject`/`this.transform.GetComponent<T>()`, 숫자 시작 해시 ID(`_2DArray` -> `_2DArrayId`), 이스케이프 따옴표(`\"`) 및 멀티라인 `static readonly`를 모두 처리합니다.
- **Roslyn `FixAllProvider` 순차 적용 및 `partial class` 타 파일 `Awake()` 지원**:
  - `CacheComponentInAwakeCodeFixProvider`와 `ExtractPropertyToIdCodeFixProvider`에 순차 `SequentialFixAllProvider`를 도입해 한 클래스 내 다중 `UB1001`/`UB1002`/`UB1003` **Fix All** 시 중복 `Awake()`·중복 필드 충돌을 제거했습니다.
  - 다른 `partial class` 블록이나 파일에 `Awake()`가 있는 경우에도 해당 `Awake()`에 초기화 구문을 주입(`Solution` 단위 CodeAction)해 런타임 `NullReferenceException`을 방지합니다.

## [1.1.5] - 2026-11-21

### Fixed
- **동일 이름 Shader Struct 필드 구별**: `Step8Attributes.texcoord` vs `Step8Varyings.texcoord`처럼 서로 다른 구조체가 같은 필드명을 가질 때 Hover, Definition, References, Rename, DocumentHighlight가 소유 구조체(`containerName`)와 표현식 체인을 기준으로 정확히 구별하고, 함수 파라미터(`Vert`의 `input` vs `Frag`의 `input`) 스코프를 분리했습니다.
- **`Camera.main` (`UB1001`) `Awake()` 자동 캐싱 Quick-Fix / CodeFix 추가**: `Update()` 등의 `Camera.main` 접근에 대해 Extension Quick-Fix와 Roslyn `CacheComponentInAwakeCodeFixProvider`가 `Awake()` 캐싱 자동화를 제공합니다.

## [1.1.4] - 2026-11-21

### Fixed
- **Shader & LSP 안정화**: Include-guard `#ifndef`/`#define` 자기 자신 Dimming(`P0-1`), `#pragma` 엔트리포인트 컬럼(`P1-S1`), 비-BMP 이모지 UTF-16 오프셋(`P1-S2`), 심볼 컬럼 단어 경계 매칭(`P1-S3`), 구조체 필드 선언부 References/Rename(`P1-S4`), 블록 주석 종료 줄 포매팅(`P1-S5`), 멀티라인 `#elif` 활성 줄 Dimming(`P1-S6`), `Properties` 타입 하이라이팅(`P2-S1`)을 수정했습니다.
- **Extension 런타임 & 매니페스트 정비**: `AnimatorController` YAML 섹션 경계(`P1-E2`), `.meta` 비동기 `.catch()`(`P1-E3`), 해시 추출 주석 오탐 및 타 클래스 `Awake()` 경계(`P1-E4`), `index/rebuild` 60초 타임아웃(`P1-E5`), C# CodeLens 파싱 마스킹(`P1-E6`), `package.json` 중복 grammar/미선언 `shaderlab` 제거(`P1-M1`), 이벤트 자동완성 prefix 가드(`P2-E2`), `launch.json` BOM·기존 키 보존(`P2-E3`), `.asmdef` 자기참조 범위(`P2-E5`)를 수정했습니다.
- **Roslyn & Daemon 호환성·프로토콜 수정**: `netstandard2.0` 비호환 `.Contains` 호출 3건 교체, 타 오브젝트 `GetComponent` `UB1002` 오탐 제거, `SimpleJson` UTF-8 BOM 처리 및 `UnityBrain.Daemon` 잘못된 JSON 입력 시 JSON-RPC `-32700 Parse error` 응답을 추가했습니다.

## [1.1.3] - 2026-11-21

### Fixed
- **VS Code 확장 활성화 치명적 버그 수정 (`tools/cli.mjs`)**: `rewriteVscodeImportsSync()`의 멀티라인 정규식이 `import * as vscode from 'vscode'` 이전의 `node:fs`/`node:path`/`node:os`/`node:child_process` 등 Node 내장 모듈 import를 함께 제거하여 VS Code 활성화 시 `ReferenceError: path is not defined`로 실행이 실패하던 문제를 수정했습니다.
- **VS Code Extension Host `vscode` 브리지 보강**: `extension.cjs`가 활성화 시점에 CJS `require('vscode')`를 `globalThis.__unitybrainVscode`로 먼저 바인딩한 뒤 ESM `extension.js`를 로드하도록 개선하고, 빌드된 `extension.cjs`에 대해 실제 `activate()`/`deactivate()` 실행까지 검증하는 E2E 테스트를 추가했습니다.

## [1.1.2] - 2026-11-21

### Added
- **UnitySense Shaders Explorer View (`unitySense.shaderExplorer`)**: 셰이더 파일별 Properties, Passes, `#pragma` 배리언트 수(>128 경고 포함) 및 키워드 트리를 탐색기 패널에서 바로 탐색하고 이동할 수 있으며 `unitySense.refreshShaderExplorer` 커맨드를 제공합니다.
- **Shader & Completion Configuration**: `unitySense.shader.format.indentSize`, `unitySense.shader.diagnostics.enabled`, `unitySense.completion.showEventSnippets` 설정을 정식 추가했습니다.
- **Built-Artifact E2E & Regression Suites**: 빌드된 `extension.cjs` 로드, 실제 `UnityBrain.Daemon.dll` stdio JSON-RPC 왕복, 파이프라인 RPC 프레이밍, SemVer PackageCache 정렬, MSBuild 특수문자 이스케이프, JSONC 보존, `.meta` 이동 사분면 등 회귀 테스트를 대폭 보강했습니다.

### Fixed
- **Pure C# Hover / Go to Definition 분리**: `provideDefinition`이 Ctrl+Hover 시 UDP 패킷, 토스트 또는 에디터 닫기 부작용 없이 순수 `vscode.Location`을 반환하도록 분리하고, `F12` (`unitySense.csharpGoToDefinition`, `unitySense.isUnityProject && editorTextFocus && editorLangId == csharp`)가 라이브 Unity UDP 연동 및 오프라인/연결 실패 시 로컬 파일 폴백을 처리합니다.
- **Daemon & RPC 안정성 강화**: `RpcServer.ReadFrameAsync`의 헤더 1바이트 단위 읽기로 파이프라인 연속 프레임 오버리드를 제거하고, `UnityDaemonClient`에 5초 재시도 쿨다운/서킷 브레이커, 15초 요청 타임아웃, bounded `stderr` 드레인, 종료 시 섀도우 디렉터리 정리 및 멱등 `dispose()`를 적용했습니다.
- **ShaderLab / HLSL / UI Toolkit / Asmdef / Meta / MSBuild / Launch.json 정확도 개선**:
  - `ShaderLab` 주석/문자열/Stencil `Pass` 마스킹, `RW_TEXTURE2D`/`RW_TEXTURE2D_X`/`TEXTURE2D_X_*` 매크로, ReDoS 없는 선형 시간 함수/프로퍼티 정규식, range/on-type 포매터 및 `eval` 없는 전처리기 조건 파서를 적용했습니다.
  - `.asmdef` 순환 검사 O(V+E) 최적화 및 더티 문서 메모리 오버레이 검증, `.uss` 블록/주석/`@import` 처리, `launch.json` 문자열 안전 JSONC 스트리퍼(파싱 실패 시 덮어쓰기 중단) 및 `processId` 비고정, `MsbuildAnalyzerInjector`의 `%25`/`%27`/`%3B`/`%24` 선행 이스케이프, `.meta` 4사분면 이동·삭제 동기화를 완료했습니다.

## [1.1.1] - 2026-11-20

### Fixed
- VSIX 패키징 OPC `[Content_Types].xml`, `extension.vsixmanifest` 메타데이터 및 불필요한 데몬 런타임 바이너리 제외(`UnityBrain.Daemon.dll`, `.runtimeconfig.json` 전용)를 정비했습니다.
- `UnityBrain.Analyzers.csproj`에 `UseNuGetNetStandard=true` (`netstandard2.0` + `Microsoft.CodeAnalysis.CSharp.Workspaces 4.3.1`) 프로파일 및 오프라인 `.NET` Ref 빌드 호환 폴리필을 정비했습니다.

## [1.1.0] - 2026-11-20

### Added
- **Omni Shader 확장 지원**: `.urtshader`, `.hlsli`, `.cg`, `.hlslinc`, `.raytrace`, `.fx`, `.fxh` 확장자, Shader Live Profiler(`unitySense.testCurrentShader`), `ShaderSemanticTokensProvider`, `ShaderDocumentSymbolProvider`, `ShaderSignatureHelpProvider`, `ShaderRenameProvider`, `ShaderFormattingProvider`, `ShaderKeywordContextStatusBar` 및 Unity 6 `#include_with_pragmas` / `#pragma dynamic_branch` 지원을 확장했습니다.
- **Unity 6 및 생태계 확장**: `async Awaitable` 이벤트 생성, `UIBehaviour`/`NetworkBehaviour` 지원, Nested Prefab/Prefab Variant 및 중첩 `propertyPath` 인스펙터 CodeLens, Roslyn `DiagnosticSuppressor`(`CS0649`/`CS0169`/`IDE0051`), `.asmdef` InlayHint/순환 참조 진단, UI Toolkit(`.uxml`, `.uss`) 연동 및 Unity Editor UDP 이동 통합을 강화했습니다.

## [1.0.0] - 2026-11-20

### Added
- **Phase 1 — Core & Virtual VFS**: `UnityProjectContextManager`, `UnityVirtualPathResolver` (5대 패키지 소스 및 Unity 6 Hash/PackageCache 지원), `tools/api-extractor` 및 `unity-api.json` DB.
- **Phase 2 — ShaderLab / HLSL / Compute Shader LSP**: 1:1 오프셋 보존 가상 HLSL 추출, Unity URP/HDRP/Built-in 매크로 프리패스, 다단계 `#include` 의존성 그래프, F12 정의 이동, Hover, 자동완성, Semantic Tokens, Outline, SignatureHelp, 비활성 전처리기 Dimming.
- **Phase 3 — Smart Domain Completion**: `ProjectSettingsWatcher`, C# 문자열 리터럴 컨텍스트 자동완성 및 F12 정의 이동, Unity 이벤트 함수 스니펫 & 일괄 생성 커맨드 (Unity 6 `Awaitable` 지원).
- **Phase 4 — Roslyn Analyzers & CodeFixes**: `Directory.Build.props` 비침습 주입기, `UB1001`~`UB1003` 성능 콜그래프 분석 & Quick-Fix, `UB2001`~`UB2004` Burst 검증, `UB3001`~`UB3003` 문자열 정합성 검사, `UB4001` `[FormerlySerializedAs]` 리팩토링, `CS0649`/`CS0169`/`IDE0051` `DiagnosticSuppressor`.
- **Phase 5 — YAML Asset Indexer & CodeLens**: 무할당 `UnityYamlStreamParser`, `UBIX` 바이너리 증분 캐시, JSON-RPC `UnityBrain.Daemon`, Nested Prefab/Prefab Variant 역참조 및 인스펙터 값 CodeLens.
- **Phase 6 — Meta Sync & Ecosystem Integration**: `.meta` 파일/폴더 생명주기 동기화 및 고아 `.meta` 정리, 셰이더 배리언트 수 CodeLens & 키워드 컨텍스트 상태 표시줄, `.asmdef` 지원, UI Toolkit(`.uxml`, `.uss`) 지원, Unity Editor 디버거(`launch.json`) 및 `Editor.log` 연동.
- **Release Packaging**: Unity 워크스페이스 전용 활성화(`workspaceContains`), `README.md`, `CHANGELOG.md`, `LICENSE`, 확장 아이콘 및 `unitysense-1.0.0.vsix` 패키징.
