# Changelog

All notable changes to the **UnityBrain** extension will be documented in this file.

## [1.1.3] - 2026-11-21

### Fixed
- **VS Code 확장 활성화 치명적 버그 수정 (`tools/cli.mjs`)**: `rewriteVscodeImportsSync()`의 멀티라인 정규식이 `import * as vscode from 'vscode'` 이전의 `node:fs`/`node:path`/`node:os`/`node:child_process` 등 Node 내장 모듈 import를 함께 제거하여 VS Code 활성화 시 `ReferenceError: path is not defined`로 실행이 실패하던 문제를 수정했습니다.
- **VS Code Extension Host `vscode` 브리지 보강**: `extension.cjs`가 활성화 시점에 CJS `require('vscode')`를 `globalThis.__unitybrainVscode`로 먼저 바인딩한 뒤 ESM `extension.js`를 로드하도록 개선하고, 빌드된 `extension.cjs`에 대해 실제 `activate()`/`deactivate()` 실행까지 검증하는 E2E 테스트를 추가했습니다.

## [1.1.2] - 2026-11-21

### Added
- **UnityBrain Shaders Explorer View (`unityBrain.shaderExplorer`)**: 셰이더 파일별 Properties, Passes, `#pragma` 배리언트 수(>128 경고 포함) 및 키워드 트리를 탐색기 패널에서 바로 탐색하고 이동할 수 있으며 `unityBrain.refreshShaderExplorer` 커맨드를 제공합니다.
- **Shader & Completion Configuration**: `unityBrain.shader.format.indentSize`, `unityBrain.shader.diagnostics.enabled`, `unityBrain.completion.showEventSnippets` 설정을 정식 추가했습니다.
- **Built-Artifact E2E & Regression Suites**: 빌드된 `extension.cjs` 로드, 실제 `UnityBrain.Daemon.dll` stdio JSON-RPC 왕복, 파이프라인 RPC 프레이밍, SemVer PackageCache 정렬, MSBuild 특수문자 이스케이프, JSONC 보존, `.meta` 이동 사분면 등 회귀 테스트를 대폭 보강했습니다.

### Fixed
- **Pure C# Hover / Go to Definition 분리**: `provideDefinition`이 Ctrl+Hover 시 UDP 패킷, 토스트 또는 에디터 닫기 부작용 없이 순수 `vscode.Location`을 반환하도록 분리하고, `F12` (`unityBrain.csharpGoToDefinition`, `unityBrain.isUnityProject && editorTextFocus && editorLangId == csharp`)가 라이브 Unity UDP 연동 및 오프라인/연결 실패 시 로컬 파일 폴백을 처리합니다.
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
- **Omni Shader 확장 지원**: `.urtshader`, `.hlsli`, `.cg`, `.hlslinc`, `.raytrace`, `.fx`, `.fxh` 확장자, Shader Live Profiler(`unityBrain.testCurrentShader`), `ShaderSemanticTokensProvider`, `ShaderDocumentSymbolProvider`, `ShaderSignatureHelpProvider`, `ShaderRenameProvider`, `ShaderFormattingProvider`, `ShaderKeywordContextStatusBar` 및 Unity 6 `#include_with_pragmas` / `#pragma dynamic_branch` 지원을 확장했습니다.
- **Unity 6 및 생태계 확장**: `async Awaitable` 이벤트 생성, `UIBehaviour`/`NetworkBehaviour` 지원, Nested Prefab/Prefab Variant 및 중첩 `propertyPath` 인스펙터 CodeLens, Roslyn `DiagnosticSuppressor`(`CS0649`/`CS0169`/`IDE0051`), `.asmdef` InlayHint/순환 참조 진단, UI Toolkit(`.uxml`, `.uss`) 연동 및 Unity Editor UDP 이동 통합을 강화했습니다.

## [1.0.0] - 2026-11-20

### Added
- **Phase 1 — Core & Virtual VFS**: `UnityProjectContextManager`, `UnityVirtualPathResolver` (5대 패키지 소스 및 Unity 6 Hash/PackageCache 지원), `tools/api-extractor` 및 `unity-api.json` DB.
- **Phase 2 — ShaderLab / HLSL / Compute Shader LSP**: 1:1 오프셋 보존 가상 HLSL 추출, Unity URP/HDRP/Built-in 매크로 프리패스, 다단계 `#include` 의존성 그래프, F12 정의 이동, Hover, 자동완성, Semantic Tokens, Outline, SignatureHelp, 비활성 전처리기 Dimming.
- **Phase 3 — Smart Domain Completion**: `ProjectSettingsWatcher`, C# 문자열 리터럴 컨텍스트 자동완성 및 F12 정의 이동, Unity 이벤트 함수 스니펫 & 일괄 생성 커맨드 (Unity 6 `Awaitable` 지원).
- **Phase 4 — Roslyn Analyzers & CodeFixes**: `Directory.Build.props` 비침습 주입기, `UB1001`~`UB1003` 성능 콜그래프 분석 & Quick-Fix, `UB2001`~`UB2004` Burst 검증, `UB3001`~`UB3003` 문자열 정합성 검사, `UB4001` `[FormerlySerializedAs]` 리팩토링, `CS0649`/`CS0169`/`IDE0051` `DiagnosticSuppressor`.
- **Phase 5 — YAML Asset Indexer & CodeLens**: 무할당 `UnityYamlStreamParser`, `UBIX` 바이너리 증분 캐시, JSON-RPC `UnityBrain.Daemon`, Nested Prefab/Prefab Variant 역참조 및 인스펙터 값 CodeLens.
- **Phase 6 — Meta Sync & Ecosystem Integration**: `.meta` 파일/폴더 생명주기 동기화 및 고아 `.meta` 정리, 셰이더 배리언트 수 CodeLens & 키워드 컨텍스트 상태 표시줄, `.asmdef` 지원, UI Toolkit(`.uxml`, `.uss`) 지원, Unity Editor 디버거(`launch.json`) 및 `Editor.log` 연동.
- **Release Packaging**: Unity 워크스페이스 전용 활성화(`workspaceContains`), `README.md`, `CHANGELOG.md`, `LICENSE`, 확장 아이콘 및 `unitybrain-1.0.0.vsix` 패키징.
