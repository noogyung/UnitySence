# Changelog

All notable changes to the **UnityBrain** extension will be documented in this file.

## [1.0.0] - 2026-11-20

### Added
- **Phase 1 — Core & Virtual VFS**: `UnityProjectContextManager`, `UnityVirtualPathResolver` (5대 패키지 소스 및 Unity 6 Hash/PackageCache 지원), `tools/api-extractor` 및 `unity-api.json` DB.
- **Phase 2 — ShaderLab / HLSL / Compute Shader LSP**: 1:1 오프셋 보존 가상 HLSL 추출, Unity URP/HDRP/Built-in 매크로 프리패스, 다단계 `#include` 의존성 그래프, F12 정의 이동, Hover, 자동완성, Semantic Tokens, Outline, SignatureHelp, 비활성 전처리기 Dimming.
- **Phase 3 — Smart Domain Completion**: `ProjectSettingsWatcher`, C# 문자열 리터럴 컨텍스트 자동완성 및 F12 정의 이동, Unity 이벤트 함수 스니펫 & 일괄 생성 커맨드 (Unity 6 `Awaitable` 지원).
- **Phase 4 — Roslyn Analyzers & CodeFixes**: `Directory.Build.props` 비침습 주입기, `UB1001`~`UB1003` 성능 콜그래프 분석 & Quick-Fix, `UB2001`~`UB2004` Burst 검증, `UB3001`~`UB3003` 문자열 정합성 검사, `UB4001` `[FormerlySerializedAs]` 리팩토링, `CS0649`/`CS0169`/`IDE0051` `DiagnosticSuppressor`.
- **Phase 5 — YAML Asset Indexer & CodeLens**: 무할당 `UnityYamlStreamParser`, `UBIX` 바이너리 증분 캐시, JSON-RPC `UnityBrain.Daemon`, Nested Prefab/Prefab Variant 역참조 및 인스펙터 값 CodeLens.
- **Phase 6 — Meta Sync & Ecosystem Integration**: `.meta` 파일/폴더 생명주기 동기화 및 고아 `.meta` 정리, 셰이더 배리언트 수 CodeLens & 키워드 컨텍스트 상태 표시줄, `.asmdef` 지원, UI Toolkit(`.uxml`, `.uss`) 지원, Unity Editor 디버거(`launch.json`) 및 `Editor.log` 연동.
- **Release Packaging**: Unity 워크스페이스 전용 활성화(`workspaceContains`), `README.md`, `CHANGELOG.md`, `LICENSE`, 확장 아이콘 및 `unitybrain-1.0.0.vsix` 패키징.
