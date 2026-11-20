# UnityBrain

**JetBrains Rider 수준의 Unity 개발 지능형 지원 VS Code 확장**

UnityBrain은 VS Code에서 Unity(Unity 2022 / Unity 6 포함) 프로젝트를 개발할 때 필요한 **ShaderLab/HLSL LSP**, **Roslyn 성능·정합성 분석기 & Quick-Fix**, **Unity YAML 에셋 인덱서 & CodeLens**, **`.meta` 생명주기 자동 동기화**, **`.asmdef` / UI Toolkit(`.uxml`, `.uss`) / Unity Editor 연동**을 제공합니다.

## 주요 기능

- **ShaderLab / HLSL / Compute Shader LSP**
  - `Packages/...`, `Assets/...`, `CGIncludes` 가상 경로 해석 및 다단계 `#include` 정의 이동(F12), Hover, 자동완성
  - `#pragma multi_compile` / `shader_feature` 배리언트 수 계산 CodeLens 및 키워드 컨텍스트 상태 표시줄 전환
  - 비활성 전처리기 분기 Dimming, DocumentSymbol, SignatureHelp, DocumentHighlight, Semantic Tokens
- **C# Unity 도메인 자동완성 & F12 정의 이동**
  - Tag, Layer, SortingLayer, Input Axis, Build Scene, Shader Property, Animator Parameter, `Resources.Load`, `InputActions`, `.Q<T>` 컨텍스트 자동완성 및 F12 이동
  - `MonoBehaviour` / `ScriptableObject` / `Editor` / `UIBehaviour` 이벤트 함수 스니펫 및 일괄 생성 커맨드 (Unity 6 `async Awaitable` 포함)
- **Roslyn 정적 분석기 (`UB1xxx`~`UB4xxx`) & CodeFix**
  - `UB1001`/`UB1002`: `Update`/`FixedUpdate`/`LateUpdate` 콜그래프 내 `GetComponent`, `Camera.main`, `FindObjectOfType` 등 탐지 및 `Awake()` 자동 캐싱 Quick-Fix
  - `UB1003`: `Shader.PropertyToID` / `Animator.StringToHash` 정적 필드 추출 Quick-Fix
  - `UB2001`~`UB2004`: `[BurstCompile]` 관리형 타입/박싱/예외/문자열 검증
  - `UB3001`~`UB3003`: Tag/Layer/Scene/Invoke/Coroutine 문자열 정합성 검증
  - `UB4001`: `[FormerlySerializedAs]` 리팩토링 및 Unity 직렬화 필드(`CS0649`/`CS0169`/`IDE0051`) 경고 억제
- **Unity YAML 에셋 인덱서 & CodeLens**
  - 씬(`.unity`), 프리팹(`.prefab`, Nested Prefab / Prefab Variant), `.asset` 역참조 카운트, 인스펙터 직렬화 값 및 `UnityEvent` 콜백 CodeLens
- **생태계 통합**
  - 탐색기 파일/폴더 생성·이름변경·삭제 시 `.meta` 및 GUID 자동 동기화
  - `.asmdef` 참조 InlayHint/F12/순환 참조 진단, UI Toolkit(`.uxml`, `.uss`) 자동완성 및 정의 이동
  - `EditorInstance.json` 기반 디버거 설정(`.vscode/launch.json`) 생성 및 `Editor.log` 열기

## 요구 사항

- **VS Code** `^1.90.0`
- **.NET 10 Runtime** (백그라운드 YAML 에셋 인덱서 데몬 `UnityBrain.Daemon` 실행에 필요)
- (선택) C# Dev Kit / C# 확장 (Roslyn 분석기 및 CodeFix 연동)

## 활성화 조건

UnityBrain은 Unity 프로젝트 워크스페이스(`ProjectSettings/ProjectVersion.txt` 또는 `Assets` 폴더 포함)에서만 활성화됩니다.

## 주요 설정

- `unityBrain.metaSync.enabled` (`boolean`, 기본 `true`): `.meta` 파일 및 GUID 자동 동기화
- `unityBrain.codeLens.enabled` (`boolean`, 기본 `true`): 에셋 참조, 이벤트 콜백, 인스펙터 값, 셰이더 배리언트 CodeLens 표시
- `unityBrain.analyzers.enabled` (`boolean`, 기본 `true`): `Directory.Build.props`를 통한 Roslyn 분석기 자동 주입
- `unityBrain.unityEditorPath` (`string`, 기본 `""`): Unity Editor 설치 경로 수동 지정

## 빌드 및 테스트

```powershell
node tools/cli.mjs typecheck
node tools/cli.mjs test
dotnet test UnityBrain.sln -nodeReuse:false -p:UseSharedCompilation=false -m:1
node tools/cli.mjs package:vsix
```
