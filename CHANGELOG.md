# Changelog

All notable changes to the **UnitySense** extension will be documented in this file.

## [1.0.0] - 2026-11-21

### Added
- **Core & Virtual VFS**: `UnityProjectContextManager`, `UnityVirtualPathResolver` (Embedded/Local/Registry/Git/Built-in/Unity 6 PackageCache SemVer 폴백 및 `CGIncludes` 지원), `unity-api.json` API 데이터베이스.
- **ShaderLab / HLSL / Compute / Raytrace LSP & Omni Shader Tools**:
  - `.shader`, `.urtshader`, `.hlsl`, `.hlsli`, `.cginc`, `.cg`, `.compute`, `.hlslinc`, `.raytrace`, `.fx`, `.fxh` 지원.
  - 1:1 UTF-16 오프셋 보존 가상 HLSL 추출, URP/HDRP/Built-in 매크로 프리패스(`TEXTURE2D_X_*`, `RW_TEXTURE2D`), 다단계 `#include` 및 Unity 6 `#include_with_pragmas` 의존성 그래프.
  - 구조체별 동일 필드명(`containerName` & 표현식 체인) 구별 기반 Definition(`F12`), Hover, References, Rename, DocumentHighlight, Semantic Tokens, Outline, SignatureHelp, Color 미리보기, Formatting(문서/범위/On-Type).
  - **UnitySense Shaders** 탐색기 뷰(`unitySense.shaderExplorer`), **Shader Live Profiler(`unitySense.testCurrentShader`)**, `#pragma` 배리언트 수 CodeLens, 키워드 컨텍스트 상태 표시줄 전환 및 `#if`/`#elif`/`#if 0`/`#define FOO 0` 비활성 분기 Dimming.
- **C# Smart Domain Completion & F12 Definition**:
  - Tag, Layer, SortingLayer, Input Axis, Build Scene, Shader Property, Animator Parameter, `Resources.Load`, `InputActions`, `.Q<T>` 컨텍스트 문자열 자동완성 및 순수 Location Hover + Live Unity Editor UDP / 로컬 파일 `F12` 정의 이동.
  - `MonoBehaviour`, `NetworkBehaviour`, `UIBehaviour`, `ScriptableObject`, `Editor`, `StateMachineBehaviour` 이벤트/코루틴/Unity 6 `async Awaitable` 자동 생성 및 일괄 생성 커맨드.
- **Roslyn Static Analyzers (`UB1xxx`~`UB4xxx`) & CodeFixes**:
  - `Directory.Build.props` 비침습 MSBuild 주입기, `netstandard2.0` 호환 API 및 `SequentialFixAllProvider`(단건 + `Fix All` + `partial class` 타 파일 `Awake()` 지원).
  - `UB1001`/`UB1002`: 콜그래프 기반 `Camera.main`, `GetComponent<T>()`, `FindObjectOfType` 탐지 및 `Awake()` 자동 캐싱 Quick-Fix/CodeFix (`Awake() => ...;` 블록 변환 포함).
  - `UB1003`: `Shader.PropertyToID` / `Animator.StringToHash` 정적 필드 추출 Quick-Fix/CodeFix.
  - `UB2001`~`UB2004`: `[BurstCompile]` 관리형 타입/박싱/문자열/예외 검사.
  - `UB3001`~`UB3003`: Tag/Layer/Scene/`Invoke`/`StartCoroutine` 문자열 정합성 검사.
  - `UB4001`: `[FormerlySerializedAs]` 리팩토링 및 Unity 직렬화 필드(`CS0649`/`CS0169`/`IDE0051`) 경고 억제.
- **YAML Asset Indexer & CodeLens (`UnityBrain.Daemon`)**:
  - `.unity`, `.prefab`(Nested Prefab / Prefab Variant), `.asset`, `.controller` 무할당 스트리밍 파싱 및 증분 `UBIX` 바이너리 캐시, Content-Length JSON-RPC 데몬, 사용처·인스펙터 값·`UnityEvent` 콜백 CodeLens.
- **Ecosystem Integration**:
  - `.meta`/GUID 4사분면 생명주기 자동 동기화 및 고아 `.meta` 정리, `.asmdef` InlayHint/F12/순환 참조 진단, UI Toolkit(`.uxml`, `.uss`) 지원, `.vscode/launch.json` JSONC 안전 병합 및 `Editor.log` 열기.
- **Release Packaging & CI**: `.vscodeignore`, VS Code Marketplace 호환 매니페스트, `netstandard2.0` + `.NET 8.0+` 범용 빌드 프로파일, GitHub Actions VSIX 릴리스 워크플로 및 `unitysense-1.0.0.vsix`.
