# Changelog

All notable changes to the **UnitySense** extension will be documented in this file.

## [Unreleased]

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
