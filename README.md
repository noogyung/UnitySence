# UnitySense

**JetBrains Rider 수준의 Unity 개발 지능형 지원 VS Code 확장** (`v1.0.0`)

UnitySense는 VS Code에서 Unity(Unity 2022 / Unity 6 포함) 프로젝트를 개발할 때 필요한 **ShaderLab/HLSL/Compute/Raytrace LSP & Shader Explorer**, **Roslyn 성능·정합성 분석기 & Quick-Fix**, **Unity YAML 에셋 인덱서 & CodeLens**, **`.meta` 생명주기 자동 동기화**, **`.asmdef` / UI Toolkit(`.uxml`, `.uss`) / Unity Editor 연동**을 제공합니다.

## 주요 기능

- **ShaderLab / HLSL / Compute Shader LSP & Shader Explorer**
  - `.shader`, `.urtshader`, `.hlsl`, `.hlsli`, `.cginc`, `.cg`, `.compute`, `.hlslinc`, `.raytrace`, `.fx`, `.fxh` 가상 경로 해석(`Packages/...`, `Assets/...`, `CGIncludes`, SemVer PackageCache 폴백) 및 다단계 `#include` 정의 이동(F12), Hover, 자동완성
  - `#pragma multi_compile` / `shader_feature` / Unity 6 `#pragma dynamic_branch` 배리언트 수 계산 CodeLens, 키워드 컨텍스트 상태 표시줄 전환, `#if` 비활성 분기 Dimming
  - **UnitySense Shaders** 탐색기 뷰(`unitySense.shaderExplorer`)로 프로젝트 셰이더의 Properties, Passes, Variant(128개 초과 경고) 및 Keywords 트리 탐색
  - **Shader Live Profiler (`unitySense.testCurrentShader`)**: TMU/ALU 추정 부하 등급 분석 및 Diagnostic 출력
  - Semantic Tokens, DocumentSymbol, SignatureHelp, Rename, Formatting / Range / On-Type 포매팅 지원
- **C# Unity 도메인 자동완성 & F12 정의 이동**
  - Tag, Layer, SortingLayer, Input Axis, Build Scene, Shader Property, Animator Parameter, `Resources.Load`, `InputActions`, `.Q<T>` 컨텍스트 자동완성
  - Ctrl+Hover는 부작용 없는 순수 `vscode.Location`을 제공하고, `F12`(`unitySense.csharpGoToDefinition`)는 실행 중인 Unity Editor UDP 이동과 로컬 파일 폴백을 모두 지원
  - `MonoBehaviour`, `NetworkBehaviour`, `UIBehaviour`, `ScriptableObject`, `Editor`, `StateMachineBehaviour` 이벤트 함수 스니펫 및 일괄 생성 커맨드 (Unity 6 `async Awaitable` 포함)
- **Roslyn 정적 분석기 (`UB1xxx`~`UB4xxx`) & CodeFix**
  - `UB1001`/`UB1002`: `Update`/`FixedUpdate`/`LateUpdate` 콜그래프 내 `GetComponent`, `Camera.main`, `FindObjectOfType` 등 탐지 및 `Awake()` 자동 캐싱 Quick-Fix
  - `UB1003`: `Shader.PropertyToID` / `Animator.StringToHash` 정적 필드 추출 Quick-Fix
  - `UB2001`~`UB2004`: `[BurstCompile]` 관리형 타입/박싱/예외/문자열 검증
  - `UB3001`~`UB3003`: Tag/Layer/Scene/Invoke/Coroutine 문자열 정합성 검증
  - `UB4001`: `[FormerlySerializedAs]` 리팩토링 및 Unity 직렬화 필드(`CS0649`/`CS0169`/`IDE0051`) 경고 억제
- **Unity YAML 에셋 인덱서 & CodeLens**
  - 무할당 스트리밍 YAML 파서 기반 씬(`.unity`), 프리팹(`.prefab`, Nested Prefab / Prefab Variant), `.asset`, `.controller` 역참조 카운트, 인스펙터 직렬화 값 및 `UnityEvent` 콜백 CodeLens
- **생태계 통합**
  - 탐색기 파일/폴더 생성·이동(4사분면)·삭제 시 `.meta` 및 GUID 자동 동기화 (`unitySense.cleanOrphanMetaFiles` 포함)
  - `.asmdef` 참조 InlayHint/F12/순환 참조 O(V+E) 실시간 진단, UI Toolkit(`.uxml`, `.uss`) 자동완성 및 정의 이동
  - `EditorInstance.json` 기반 디버거 설정(`.vscode/launch.json`) 안전 병합 생성 및 `Editor.log` 열기

## 요구 사항

- **VS Code** `^1.90.0`
- **.NET Runtime** (백그라운드 YAML 에셋 인덱서 데몬 `UnityBrain.Daemon` 실행에 필요)
- **Node.js** `>=22.15.0` (소스 빌드/테스트용)
- (선택) C# Dev Kit / C# 확장 (Roslyn 분석기 및 CodeFix 연동)

## 활성화 조건

UnitySense은 Unity 프로젝트 워크스페이스(`ProjectSettings/ProjectVersion.txt` 또는 `Assets` 폴더 포함)에서만 활성화됩니다.

## 주요 설정

- `unitySense.metaSync.enabled` (`boolean`, 기본 `true`): `.meta` 파일 및 GUID 자동 동기화
- `unitySense.codeLens.enabled` (`boolean`, 기본 `true`): 에셋 참조, 이벤트 콜백, 인스펙터 값, 셰이더 배리언트 CodeLens 표시
- `unitySense.analyzers.enabled` (`boolean`, 기본 `true`): `Directory.Build.props`를 통한 Roslyn 분석기 자동 주입
- `unitySense.unityEditorPath` (`string`, 기본 `""`): Unity Editor 설치 경로 수동 지정
- `unitySense.shader.format.indentSize` (`number`, 기본 `0`): ShaderLab/HLSL 포매팅 들여쓰기 크기 (`0` 이하면 에디터 `tabSize` 사용)
- `unitySense.shader.diagnostics.enabled` (`boolean`, 기본 `true`): ShaderLab/HLSL/Compute 정적 진단 및 SRP Batcher `CBUFFER` 검사 활성화
- `unitySense.completion.showEventSnippets` (`boolean`, 기본 `true`): C# Unity 이벤트 함수 자동완성 제안 표시

## 빌드, 테스트 및 Roslyn `.NET` 프로파일 안내

### 기본 로컬 / 오프라인 빌드 & VSIX 패키징

```powershell
node tools/cli.mjs install
node tools/cli.mjs typecheck
dotnet test UnityBrain.sln -nodeReuse:false -p:UseSharedCompilation=false -m:1
node tools/cli.mjs build
node tools/cli.mjs test
node tools/cli.mjs package:vsix
```

### `.NET` / Roslyn 타깃 프로파일 (오프라인 SDK vs 온라인 NuGet 릴리스)

- **기본 오프라인 빌드 (`UseNuGetNetStandard != true`)**: 외부 NuGet 복원 없이 로컬 .NET SDK Ref 및 `dotnet-format` 번들 Roslyn 어셈블리(`TargetFramework: net$(NETCoreAppMaximumVersion)`)를 참조하여 빌드·테스트합니다. C# Dev Kit가 구형 Roslyn 호스트를 사용하는 환경에서는 아래 온라인 NuGet 프로파일로 분석기 DLL을 빌드해야 합니다.
- **온라인 릴리스 프로파일 (`-p:UseNuGetNetStandard=true`)**: NuGet에서 `Microsoft.CodeAnalysis.CSharp.Workspaces` `4.3.1` 및 `Microsoft.CodeAnalysis.Analyzers` `3.3.4`를 복원하여 Roslyn Component 표준인 `netstandard2.0` (`EnforceExtendedAnalyzerRules=true`)으로 `UnityBrain.Analyzers.csproj`를 빌드합니다.

```powershell
dotnet build analyzers/UnityBrain.Analyzers/UnityBrain.Analyzers.csproj -c Release -p:UseNuGetNetStandard=true
```
