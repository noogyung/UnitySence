# Sub-Plan 03: Smart Domain Completion & Event Generator

> **상위 마스터 문서**: [../../PLAN.md](../../PLAN.md)  
> **예상 기간**: Week 6 ~ Week 7 (Phase 3)  
> **선행 조건**: [01-core-and-virtual-vfs.md](01-core-and-virtual-vfs.md), [02-shaderlab-hlsl-lsp.md](02-shaderlab-hlsl-lsp.md)

---

## 1. 목적 및 목표 (Purpose & Goal)

### 1.1 목적
Microsoft `csharp` + `vstuc` 확장이 제공하지 못하는 **Unity 프로젝트 에셋 및 설정 파일 기반의 컨텍스트 인식 C# 자동완성**을 구현한다. 또한 `resharper-unity`의 `api.xml` 데이터베이스를 활용하여, Unity 버전과 현재 클래스 상속 계층에 맞는 이벤트 함수 시그니처를 코루틴 지원 여부까지 포함해 즉시 생성한다.

### 1.2 목표
1. `ProjectSettings/*.asset`, `.inputactions`, `.controller`를 실시간 감시하여 `ProjectSettingsCache` JSON을 유지하는 `ProjectSettingsWatcher` 구축.
2. C# 문자열 리터럴 컨텍스트(`CompareTag("|")`, `GetAxis("|")`, `LoadScene("|")`, `SetFloat("|")`, `StringToHash("|")`, `StartCoroutine("|")`, `Invoke("|")` 등)를 인식해 프로젝트 실제 데이터를 자동완성으로 제안.
3. `unity-api.json` 기반의 C# 이벤트 함수 스니펫 완성 및 `unityBrain.generateEventFunctions` 일괄 생성 커맨드 구현.

---

## 2. 생성할 파일 및 심볼 명세

| 파일 경로 | 핵심 Export 심볼 | 역할 |
| :--- | :--- | :--- |
| `packages/extension/src/watchers/projectSettingsWatcher.ts` | `ProjectSettingsWatcher` | Unity YAML 설정/에셋 파싱 및 `Library/UnityBrainCache/project-settings.json` 동기화 |
| `packages/extension/src/completion/unityStringCompletionProvider.ts` | `UnityStringCompletionProvider` | C# 문자열 리터럴 API 컨텍스트별 도메인 자동완성 (`CompletionItemProvider`) |
| `packages/extension/src/completion/unityEventGenerator.ts` | `UnityEventCompletionProvider`, `registerGenerateEventFunctionsCommand` | 이벤트 함수 타이핑 완성 + QuickPick 다중 선택 일괄 생성 |

---

## 3. 세부 구현 알고리즘 및 기술 설계

### 3.1 `ProjectSettingsWatcher` (`projectSettingsWatcher.ts`)
Unity의 YAML 파일(`%YAML 1.1`)은 비표준 태그(`!u!78`, `stripped`)를 포함하므로 범용 YAML 파서(예: `js-yaml`) 그대로 돌리면 파싱 에러가 난다. 따라서 Unity YAML 헤더와 `!u!` 태그를 전처리 스트립한 뒤 파싱하거나 전용 경량 라인 스캐너로 아래 항목을 추출한다.

1. **`ProjectSettings/TagManager.asset`**:
   * `tags:` 배열 + Unity 기본 내장 태그 7종(`Untagged`, `Respawn`, `Finish`, `EditorOnly`, `MainCamera`, `Player`, `GameController`) 병합 → `tags: string[]`.
   * `layers:` 배열(인덱스 `0~31`)에서 빈 문자열이 아닌 항목만 `{ index, name }`으로 수집.
   * `m_SortingLayers:` 배열에서 `name`, `uniqueID` 수집 → `sortingLayers`.
2. **`ProjectSettings/InputManager.asset`**:
   * `m_Axes:` 하위 각 `m_Name:` 값을 중복 제거하여 `inputAxes`에 수집.
3. **`ProjectSettings/EditorBuildSettings.asset`**:
   * `m_Scenes:` 하위 `enabled: 1`인 항목의 `path` 및 파일명(확장자 제외 `name`), `guid`, `buildIndex` 추출.
4. **`Assets/**/*.controller` (Animator Controller YAML)**:
   * `AnimatorController` 문서 내 `m_AnimatorParameters:` 목록에서 `m_Name` 및 `m_Type` (`1: Float, 3: Int, 4: Bool, 9: Trigger`) 추출.
   * `AnimatorState` 문서 내 `m_Name` 수집.
5. **캐시 저장 및 실시간 감시**:
   * `vscode.workspace.createFileSystemWatcher`로 위 파일들의 변경/생성/삭제를 감시(300ms debounce).
   * 결과를 `PLAN.md` §3.3의 `ProjectSettingsCache` 포맷으로 `{projectRoot}/Library/UnityBrainCache/project-settings.json`에 기록한다. (Sub-Plan 04의 Roslyn Analyzer가 이 파일을 `AdditionalFiles`로 읽음)

### 3.2 `UnityStringCompletionProvider` (`unityStringCompletionProvider.ts`)
VS Code의 `vscode.languages.registerCompletionItemProvider('csharp', provider, '"')`로 등록한다.

1. **커서 컨텍스트 판별 (`detectApiStringContext`)**:
   * 현재 라인 및 직전 3줄(멀티라인 호출 대응)의 토큰을 분석해 커서가 `"..."` 내부에 있고, 직전 호출/비교 패턴이 아래 매핑표와 일치하는지 판별한다.
   * 문자열·주석 오탐을 막기 위해 커서 앞 열린 따옴표 개수를 체크한다.

| C# 호출 / 표현식 패턴 | 데이터 소스 | `CompletionItem` 상세 정보 (`detail`) |
| :--- | :--- | :--- |
| `CompareTag("`, `FindWithTag("`, `FindGameObjectWithTag("`, `FindGameObjectsWithTag("`, `.tag == "`, `.tag = "` | `ProjectSettingsCache.tags` | `Unity Tag` |
| `LayerMask.NameToLayer("`, `LayerMask.GetMask("` (가변 인자 내 모든 문자열 위치 지원) | `ProjectSettingsCache.layers` | `Layer {index}` |
| `SortingLayer.NameToID("` | `ProjectSettingsCache.sortingLayers` | `Sorting Layer` |
| `Input.GetAxis("`, `Input.GetAxisRaw("`, `Input.GetButton("`, `Input.GetButtonDown("`, `Input.GetButtonUp("` | `ProjectSettingsCache.inputAxes` | `Input Axis` |
| `SceneManager.LoadScene("`, `SceneManager.LoadSceneAsync("`, `SceneManager.GetSceneByName("` | `ProjectSettingsCache.buildScenes` | `Build Index {buildIndex} ({path})` |
| `Shader.PropertyToID("`, `Material.Set*("`, `Material.Get*("`, `Material.HasProperty("` (첫 번째 문자열 인자) | `shader-lsp`의 `ShaderSymbolIndex.properties` | `{propertyType} in {shaderName}` |
| `Animator.StringToHash("`, `animator.Set*("`, `animator.Get*("`, `animator.ResetTrigger("` (첫 번째 문자열 인자) | `ProjectSettingsCache.animatorControllers` | `{paramType} ({controllerName})` |
| `Invoke("`, `InvokeRepeating("`, `CancelInvoke("`, `IsInvoking("`, `StartCoroutine("`, `StopCoroutine("` | 현재 C# 파일 동일 클래스 내 메서드 선언 목록 (메서드명 + 시그니처 필터: `StartCoroutine`은 반환형 `IEnumerator` 우선 정렬) | `Method in {ClassName}` |

2. **충돌 방지**:
   * 커서가 위 API 문자열 리터럴 내부일 때만 아이템을 반환하고, 일반 C# 코드 위치에서는 빈 배열(`undefined`)을 반환하여 C# Dev Kit / Roslyn의 기본 자동완성에 간섭하지 않는다.

### 3.3 `UnityEventGenerator` (`unityEventGenerator.ts`)
1. **상속 클래스 판별**:
   * 현재 C# 문서의 커서가 위치한 클래스 선언(`class Foo : Bar, IBaz`)을 파싱하고, 상속 베이스(`MonoBehaviour`, `ScriptableObject`, `Editor`, `EditorWindow`, `StateMachineBehaviour`, `AssetPostprocessor`, `NetworkBehaviour` 등)를 식별한다.
   * 상속 계층이 간접적인 경우(예: `PlayerController : BaseCharacter`, `BaseCharacter : MonoBehaviour`) C# LSP의 `vscode.executeTypeDefinitionProvider` 또는 워크스페이스 내 클래스 상속 맵 캐시를 조회해 `unity-api.json`의 루트 Unity 타입으로 귀결시킨다.
2. **스니펫 자동완성 (`UnityEventCompletionProvider`)**:
   * 커서가 클래스 본문 내부(메서드 내부가 아님, 중괄호 깊이 1 또는 네임스페이스 포함 2)이고 멤버 선언 위치일 때 동작.
   * `unity-api.json`에서 해당 타입이 지원하는 이벤트 중 **현재 클래스에 아직 선언되지 않은 이벤트**만 필터링해 제안한다.
   * `CompletionItem.insertText`는 `vscode.SnippetString`으로 생성:
     * 예: `private void OnTriggerEnter(Collider other)\n{\n\t$0\n}`
     * `supportsCoroutine === true`인 이벤트(`Start`, `OnTriggerEnter` 등)는 `IEnumerator` 반환형 변형도 보조 아이템(`OnTriggerEnter (Coroutine)`)으로 함께 제공한다.
   * `vstuc`의 기본 완성과 겹치지 않도록 `sortText` 우선순위 제어 및 설정 옵션(`unityBrain.completion.showEventSnippets`) 제공.
3. **일괄 생성 커맨드 (`unityBrain.generateEventFunctions`)**:
   * 명령 팔레트 또는 에디터 우클릭/단축키로 실행.
   * 현재 클래스에서 생성 가능한 미구현 Unity 이벤트 목록을 `vscode.window.showQuickPick(..., { canPickMany: true })`로 표시하고, 선택된 함수들을 커서 위치(또는 클래스 끝)에 포매팅하여 일괄 삽입한다.

---

## 4. 검증 기준 및 완료 조건 (Verification & Definition of Done)

`packages/extension`에 Vitest 단위/통합 테스트를 작성하고 아래 항목이 모두 통과해야 한다.

1. **YAML 파서 테스트**: 샘플 `TagManager.asset`, `InputManager.asset`, `EditorBuildSettings.asset`, `.controller`를 파싱해 `ProjectSettingsCache` 스키마와 100% 일치하는 결과를 내는지 검증.
2. **문자열 컨텍스트 자동완성 테스트**: 위 매핑표의 **모든 API 패턴**(Tag, Layer 다중인자, SortingLayer, Input, Scene, ShaderProperty, Animator, Invoke, StartCoroutine)에 대해 정확한 후보만 반환하고 일반 C# 문자열(`Debug.Log("...")`)에서는 아무것도 반환하지 않는지 검증.
3. **이벤트 생성기 테스트**:
   * `MonoBehaviour` 상속 클래스에서 이미 `Update()`가 구현되어 있을 때 `Update`는 제외하고 나머지 이벤트만 제안하는지 검증.
   * 코루틴 지원 이벤트 선택 시 `IEnumerator` 스니펫이 올바른 문법으로 삽입되는지 검증.
4. **실행 명령**: `pnpm --filter @unitybrain/extension test` 전체 Pass.
