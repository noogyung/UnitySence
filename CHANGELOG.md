# Changelog

All notable changes to the **UnitySense** extension will be documented in this file.

## [Unreleased]

## [1.2.0] - 2026-11-26

### Added
- **레거시 `CGPROGRAM` / `CGINCLUDE` 블록 안내 및 내장 `.cginc` 오탐 완화**:
  - `CGPROGRAM` / `CGINCLUDE` 블록 사용 시 최신 Unity/SRP 환경에 맞춰 `HLSLPROGRAM` / `HLSLINCLUDE` 전환을 권장하는 경고를 표시합니다.
  - Unity 에디터 설치 경로(`cgIncludesPath`)가 감지되지 않은 환경에서 `UnityCG.cginc`, `AutoLight.cginc`, `Lighting.cginc` 등 표준 Built-in `.cginc` 미해석 오류는 조용히 무시합니다.
- **ShaderLab `CustomEditor` / `Fallback` / `UsePass` F12 이동 및 미구현 경고 · Unity `Editor.log` 셰이더 진단 연동**:
  - `CustomEditor` 음수 캐싱 및 오래된 `rootFilesCache`를 제거하고 3단계 클래스 탐색 폴백(파일명+네임스페이스 → 전체 스캔 → 네임스페이스 완화)과 에디터 탭 전환 시 즉시 재진단을 추가해, `.cs` 파일을 새로 만들거나 이동한 직후에도 `CustomEditor` F12 및 미사용 프로퍼티 해제가 즉시 동작합니다.
  - `unitySense.shaderGoToDefinition` F12 키바인딩 및 커맨드를 추가하고, `shader`/`compute` 언어 ID 지원과 줄 전체 매칭·작은따옴표 안전 처리·`fromFilePath` 기반 `PackageCache` 탐색을 보강해 `CustomEditor "..."` 및 `Fallback "..."`/`UsePass "..."` 어디서든 `F12`로 바로 이동할 수 있습니다.
  - `CustomEditor` / `CustomEditorForRenderPipeline` 클래스가 프로젝트(`Assets/`) 및 패키지(`Packages/`, `Library/PackageCache/`)에 존재하지 않으면 셰이더 파일 해당 줄에 경고를 표시합니다(Unity 내장 컴파일 GUI `StandardShaderGUI` 등 제외).
  - `CustomEditor "..."`, `CustomEditorForRenderPipeline "..." "..."` 및 `Fallback "..."`, `UsePass "Shader/Pass"`에서 `F12`(정의로 이동)로 외부 UPM 패키지(`UnityEditor.Rendering.Universal.ShaderGUI.LitShader`, `Hidden/Universal Render Pipeline/FallbackError` 등)를 포함한 대상 C# 클래스 또는 셰이더/패스 선언으로 바로 이동할 수 있습니다.
  - Unity `Editor.log`의 실시간 셰이더 컴파일러 에러/경고(`Shader error/warning in '...'`)를 파싱해 열려 있는 셰이더 문서의 문제(Problems) 패널에 자동 표시하고 재임포트/재컴파일 시 오래된 진단을 정리합니다(`unityShaderLogDiagnostics`).
- **ShaderLab 미사용 프로퍼티 및 SRP Batcher 진단 정교화 (`shaderCustomEditorResolver`, `shaderEditorProviders`)**:
  - 셰이더에 선언된 `CustomEditor` / `CustomEditorForRenderPipeline` 클래스를 `Assets/` 뿐 아니라 `Packages/` 및 `Library/PackageCache/`(외부 UPM 패키지 포함)까지 탐색하고, 상속 부모 클래스·`partial class`·중첩 `static class`(`Property`, `UIBlock`, `Section` 등) 및 `*GUI`/`*Properties` 정적 헬퍼까지 추적해 참조되는 프로퍼티(`_Surface`, `_ReceiveShadows`, `_QueueOffset` 등)의 미사용 오탐 경고를 제거합니다.
  - `UNITY_DOTS_INSTANCING_START...END` / `UNITY_DOTS_INSTANCED_PROP*` / `UNITY_ACCESS_DOTS_INSTANCED_PROP*` 등 DOTS/GPU Instancing 매크로, `ShaderLibrary/` 공통 헤더, 구조체 멤버(`._Prop`), 함수 매개변수, 문자열 리터럴 일치에 의한 SRP Batcher 오탐 경고를 제거했습니다.
  - `Packages/packages-lock.json` · `manifest.json` 변경 및 `.cs` 파일 `mtime`/크기 변경을 자동 감지해 패키지 버전 업그레이드나 에디터 스크립트 수정 시 캐시를 자동 무효화하고 진단을 즉시 갱신합니다.
  - `build:extension` 실행 시 `shader-lsp` 컴파일 산출물(`dist/shader-lsp/`)도 함께 재빌드되도록 빌드 파이프라인을 보완했습니다.
- **C# · ShaderLab/HLSL 코드 줄맞춤 자동 정렬 (`CodeAutoIndentManager`)**:
  - 복사/붙여넣기(`unitySense.autoIndent.onPaste`, 기본 `true`) 시 붙여넣은 영역의 들여쓰기를 주변 중괄호·괄호·`switch`/`case` 깊이에 맞게 자동으로 정렬합니다.
  - 파일 저장(`unitySense.autoIndent.onSave`, 기본 `true`) 시 이미 작성된 코드 중 줄맞춤이 어긋난 줄을 자동으로 정렬하며, 우클릭 메뉴 및 명령 팔레트(`[UnitySense] 코드 줄맞춤 자동 정렬`)로도 실행할 수 있습니다.
  - C# 멀티라인 축자 문자열(`@"..."`)과 원시 문자열(`"""..."""`) 내부 줄의 공백은 건드리지 않습니다.

### Fixed
- **외부 패키지(`Library/PackageCache`) 및 `ShaderGUI`/`Editor` 스크립트 C# 진단 오탐 제거 · `Editor` 폴더 외부 배치 경고(`UB1004`)**:
  - `Library/PackageCache` 내부의 읽기 전용 C# 파일(예: URP `LitShader.cs`) 및 `ShaderGUI`/`Editor` 클래스에서 `UB1003`(문자열 리터럴 해시 캐싱 권장) 등 런타임 성능 경고가 발생하지 않도록 TypeScript/Roslyn 분석기 양쪽을 보완했습니다.
  - `ShaderGUI`/`Editor` 등 에디터 전용 클래스가 `Assets/Editor` 외부(예: `Assets/Shaders/`)에 `#if UNITY_EDITOR` 없이 선언되어 `CS0246` 컴파일 오류를 유발하는 경우 경고(`UB1004`)를 표시합니다.
  - Unity 6 `Editor.log`의 `[Worker0]` 접두사 로그, 4MB 로그 tail, 재임포트 시 `at line N` 기반 셰이더명 진단 정리를 보강하고, `ShaderGUI/Sections` 및 `PackageCache/*` 직속 탐색을 추가했습니다.
- **Git Blame 좌측 주석 열 1칸 밀림/어긋남 수정**: 한글 작성자명(`홍길동`), `미커밋`, 말줄임표(`…`), 경계선(`▎`) 등이 폴백 폰트에서 1ch보다 약간 넓거나 좁게 렌더링되어 코드 시작 위치가 1칸씩 어긋나던 문제를 고정 CSS 폭(`width: <columnWidth + 2>ch`, `overflow: clip`, `white-space: pre`, `box-sizing: border-box`) 및 경계선 `width: 1ch` 지정으로 해결했습니다.

## [1.1.0] - 2026-11-25

### Added
- **Rider 스타일 C# 시맨틱 하이라이팅 오버레이 (옵션 토글)**: 현재 테마의 배경·사이드바·UI(`workbench.colorCustomizations`)는 그대로 두고 C# 코드 하이라이팅만 JetBrains Rider Dark와 같게 적용하는 `unitySense.csharp.riderHighlighting.enabled`(기본 `false`)와 `unitySense.toggleRiderHighlighting` 커맨드를 추가했습니다. 비활성화하면 기존 사용자 설정을 완전히 원복합니다.
  - `JetBrains Rider Dark Theme`의 `tokenColors` 규칙과 시맨틱 토큰 팔레트(`namespace`/`class`/`struct: #C191FF`, `field/property: #65C3CC`, `method: #3ACC9B`, `string: #C8A16D`, `number: #EC94C0`, `comment: #85C46C` 등)를 그대로 적용합니다.
  - Roslyn(`ms-dotnettools.csharp`)과 Open VSX OmniSharp(`muhammad-sammy.csharp`)의 시맨틱 토큰, C# 전용 TextMate 스코프(`keyword.type.cs`, `punctuation.*.cs` 등)를 지원합니다.
  - 활성화 시 `[csharp]` 스코프에 `editor.bracketPairColorization.enabled: false`, `editor.semanticHighlighting.enabled: true`를 적용해 괄호 무지개 색이 Rider 중립 회색을 덮지 않도록 합니다.
  - `unitySense.csharp.riderHighlighting.distinguishStructs`(기본 `false`)를 켜면 `struct`를 별도 색으로 구분합니다.
- **Rider 스타일 경량 Git Blame (Read-Only Annotate)**: 외부 Git 라이브러리 없이 로컬 `git blame --porcelain`만 파싱해 좌측 고정 폭 열에 날짜·작성자를 표시합니다.
  - `unitySense.gitBlame.enabled`, `showGutterColumn`(기본 `true`), `groupConsecutiveCommits`(기본 `false`), `showHeatStrip`(커밋 최신도 컬러 바), `unitySense.toggleGitBlame` 커맨드와 줄 번호 우클릭 메뉴를 제공합니다.
  - `dateFormat`(기본 `YY-MM-DD`, `YYYY`/`YY`/`MM`/`M`/`DD`/`D`/`HH`/`mm`/`ss` 조합 또는 `relative`), `authorDisplay`(`name`/`email`/`emailLocalPart`/`nameAndEmail`/`none`), `columnFormat`(기본 `${date}  ${author}`, `${hash}`/`${summary}` 사용 가능), `columnWidth`(기본 `20`)로 표시 형식을 바꿀 수 있습니다.
  - `foregroundColor`, `uncommittedForegroundColor`, `backgroundColor`, `accentBarColor`(`none`이면 숨김)로 색상을 바꿀 수 있습니다.
  - 현재 커서 줄 끝 인라인 표시(`inlineCurrentLine`, `inlineFormat`, `inlineForegroundColor`)를 지원하며, 좌측 열과 함께 켤 수 있습니다.
  - 미저장 버퍼(`git blame --contents -`), 미커밋 줄, 긴 영문/한글 작성자명 말줄임(`…`), 호버 팝업의 GitFork 검색용 `커밋 해시 복사` 링크를 지원합니다.
  - 자동 줄바꿈(`editor.wordWrap`) 설정은 그대로 두고, 줄바꿈된 2번째 이후 시각 줄은 좌측 열 폭만큼 들여 써서 Blame 열을 침범하지 않습니다.
  - Unity 프로젝트가 아닌 Git 워크스페이스에서도 동작합니다 (`onStartupFinished`, `workspaceContains:.git` 활성화).
- **Antigravity IDE 지원 & Open VSX 배포**: 태그 푸시 시 GitHub Release, VS Code Marketplace(`VSCE_PAT`)와 함께 Open VSX Registry(`OVSX_PAT`)에도 게시합니다.

### Changed
- **직렬화 필드 인스펙터 값 CodeLens 기본 숨김**: `unitySense.codeLens.showSerializedFieldValues`(기본 `false`)를 추가했고, 숨김 상태에서는 `getSerializedValues` RPC 호출도 하지 않습니다.
- **유니티 이벤트 함수 CodeLens 라벨 간소화**: `[UnitySense] 유니티 이벤트 함수 (MonoBehaviour) · 매 프레임 호출`을 `MonoBehaviour` / `MonoBehaviour, 매 프레임 호출`로 줄였습니다.
- **릴리스 버전 관리 정리**: 확장 버전은 정식 릴리스 때만 올립니다. 로컬 테스트는 `node tools/cli.mjs package:vsix:dev`로 `x.y.(z+1)-dev.<시각>` 버전의 VSIX를 `dist/dev/`에 만들고, 릴리스는 `release:prepare <x.y.z>`로 준비합니다. CI는 태그·`package.json`·CHANGELOG 버전이 다르면 게시하지 않습니다(`verify:release-tag`).

## [1.0.2] - 2026-11-24

### Changed
- **`Directory.Build.props` 자동 생성 완전 제거 & 경량 C# 진단기 전환**: 대상 Unity 프로젝트에 어떤 파일도 생성하지 않도록 `MsbuildAnalyzerInjector`를 제거하고, 기존 `ProjectSettingsWatcher` 및 VS Code C# 확장의 LSP(`executeHoverProvider`)를 재활용하는 경량 `unitysense-csharp` 진단기(`UB1002`, `UB1003`, `UB2001`~`UB2004`, `UB3002`, `UB3003`)로 전환했습니다.
- **Shader 프로퍼티 사용처 및 `#include` 기반 검사 정밀화**: `[Toggle]`, `[ToggleOff]`, `[KeywordEnum]` 키워드 전용 프로퍼티와 ShaderLab 렌더 상태(`Cull [_Cull]` 등) 참조 프로퍼티의 SRP Batcher 오탐을 제거하고, `#include` 파일을 포함해 HLSL 변수로 실제 참조되는 경우에만 `CBUFFER_START(UnityPerMaterial)` 경고를, 어디에도 사용되지 않는 경우 미사용 프로퍼티 경고를 표시하도록 개선했습니다.

## [1.0.1] - 2026-11-22

### Changed
- **VS Code Marketplace Publisher ID 정규화 & 자동 게시 파이프라인 연동**: `publisher`를 소문자 Marketplace ID(`noogkim`)로 일치시키고 GitHub Actions 태그(`v*`) 푸시 시 `VSCE_PAT`를 통해 VS Code Marketplace 자동 게시가 실행되도록 연동했습니다.

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
