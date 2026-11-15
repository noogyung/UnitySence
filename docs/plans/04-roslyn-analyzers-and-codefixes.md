# Sub-Plan 04: Roslyn Analyzers & Automated CodeFixes (`analyzers/UnityBrain.Analyzers`)

> **상위 마스터 문서**: [../../PLAN.md](../../PLAN.md)  
> **예상 기간**: Week 8 ~ Week 10 (Phase 4)  
> **선행 조건**: [01-core-and-virtual-vfs.md](01-core-and-virtual-vfs.md), [03-smart-domain-completion.md](03-smart-domain-completion.md)

---

## 1. 목적 및 목표 (Purpose & Goal)

### 1.1 목적
`visualstudiotoolsforunity.vstuc`에 내장된 `Microsoft.Unity.Analyzers`가 제공하지 못하는 **JetBrains Rider 고유의 심층 정적 코드 조언(Call-Graph 성능 추적, 자동 필드 캐싱 리팩토링, Burst 컴파일 사전 검증, 에셋 문자열 정합성 검사, `[FormerlySerializedAs]` 직렬화 보호)**을 Roslyn `DiagnosticAnalyzer` / `CodeFixProvider` / `CodeRefactoringProvider`로 구현하고, Unity가 `.csproj`를 재생성해도 지워지지 않도록 MSBuild 레벨에서 자동 주입한다.

### 1.2 목표 및 중복 구현 금지 원칙
* **비중복 선언**: `Microsoft.Unity.Analyzers`의 아래 규칙들은 `vstuc`가 이미 처리하므로 **절대 재구현하지 않는다**:
  * `UNT0001`~`UNT0038` (빈 Unity 메시지, 직접적인 `tag ==`, 비제네릭 `GetComponent`, `Time.fixedDeltaTime` in `Update`, `UnityEngine.Object` `?.` / `??` / `is null`, `SetPositionAndRotation`, 직접 `new MonoBehaviour()`, 비할당 Physics API 권고 등) 및 `USPxxxx` 미사용 억제기.
* **UnityBrain 고유 규칙 (`UB1xxx`~`UB4xxx`)**:
  1. `UB1001`~`UB1003`: 콜그래프 기반 간접 성능 문맥 추적 + **One-Click 자동 캐싱 Quick-Fix**
  2. `UB2001`~`UB2004`: `[BurstCompile]` 정적 금지 패턴 검증
  3. `UB3001`~`UB3003`: 존재하지 않는 메서드명·Tag·Layer·Scene 문자열 리터럴 경고
  4. `UB4001`: `[SerializeField]` / `public` 필드 이름 변경 시 `[FormerlySerializedAs]` 자동 추가 리팩토링

---

## 2. 생성할 파일 및 심볼 명세

| 파일 경로 | 핵심 Export 심볼 | 역할 |
| :--- | :--- | :--- |
| `packages/extension/src/analyzers/msbuildInjector.ts` | `MsbuildAnalyzerInjector` | `Directory.Build.props` 관리 블록 주입 및 제거 |
| `analyzers/UnityBrain.Analyzers/UnityBrain.Analyzers.csproj` | `.NET Standard 2.0` 프로젝트 | Roslyn 4.x 타깃 Analyzer/CodeFix 어셈블리 빌드 |
| `analyzers/UnityBrain.Analyzers/DiagnosticIds.cs` | `DiagnosticIds` (`UB1001`~`UB4001`) | 모든 진단 ID 및 카테고리 상수 |
| `analyzers/UnityBrain.Analyzers/CallGraph/PerformanceCriticalContextAnalyzer.cs` | `PerformanceCriticalContextAnalyzer` | `Update` 계열 호출 그래프 구축 및 `UB1001`, `UB1002` 진단 |
| `analyzers/UnityBrain.Analyzers/Diagnostics/UncachedShaderOrAnimatorIdAnalyzer.cs` | `UncachedShaderOrAnimatorIdAnalyzer` | 문자열 셰이더/애니메이터 조회 `UB1003` 진단 |
| `analyzers/UnityBrain.Analyzers/Diagnostics/BurstCompileAnalyzer.cs` | `BurstCompileAnalyzer` | `[BurstCompile]` 컨텍스트 `UB2001`~`UB2004` 진단 |
| `analyzers/UnityBrain.Analyzers/Diagnostics/UnityStringValidationAnalyzer.cs` | `UnityStringValidationAnalyzer` | `AdditionalFiles` 기반 문자열 검증 `UB3001`~`UB3003` 진단 |
| `analyzers/UnityBrain.Analyzers/CodeFixes/CacheComponentInAwakeCodeFixProvider.cs` | `CacheComponentInAwakeCodeFixProvider` | `UB1002` → 필드 추출 + `Awake()` 캐싱 자동 작성 |
| `analyzers/UnityBrain.Analyzers/CodeFixes/ExtractPropertyToIdCodeFixProvider.cs` | `ExtractPropertyToIdCodeFixProvider` | `UB1003` → `static readonly int` 추출 및 치환 |
| `analyzers/UnityBrain.Analyzers/CodeFixes/FormerlySerializedAsRefactoringProvider.cs` | `FormerlySerializedAsRefactoringProvider` | `UB4001` → 직렬화 필드 `[FormerlySerializedAs]` 부여 리팩토링 |

---

## 3. 세부 구현 알고리즘 및 기술 설계

### 3.1 비침습적 MSBuild 주입기 (`msbuildInjector.ts`)
Unity가 스크립트 생성·수정 시 `.csproj` 파일을 재생성하므로 `.csproj`를 직접 수정하면 안 된다.

1. Extension 활성화 시 `{projectRoot}/Directory.Build.props`를 생성하거나 업데이트한다.
2. 기존 파일이 이미 존재하는 경우 내용을 파싱하여 `<!-- UnityBrain:Begin -->`과 `<!-- UnityBrain:End -->` 마커 사이만 교체한다(사용자 커스텀 MSBuild 설정 절대 보존).
3. 주입 XML 내용:
   * `<ItemGroup>` 내 `<Analyzer Include="{ExtensionInstallPath}/analyzers/UnityBrain.Analyzers.dll" />`
   * `<AdditionalFiles Include="{projectRoot}/Library/UnityBrainCache/project-settings.json" Condition="Exists('{projectRoot}/Library/UnityBrainCache/project-settings.json')" />`
   * `<AdditionalFiles Include="{ExtensionInstallPath}/resources/unity-api.json" />`
4. 설정 `unityBrain.analyzers.enabled = false` 시 마커 블록을 깨끗이 제거한다.

### 3.2 콜그래프 기반 성능 코드 조언 (`UB1001`, `UB1002`)
`Microsoft.Unity.Analyzers`는 `Update()` 본문 내부의 직접적인 비효율만 보며, `Update() -> Move() -> UpdateAnimator() -> GetComponent<Animator>()`처럼 **헬퍼 메서드를 거친 간접 호출**을 잡지 못한다. Rider는 이를 잡는다.

1. **Performance-Critical Root 식별**:
   * `AdditionalFiles`의 `unity-api.json`에서 `isPerformanceCritical: true`인 이벤트(`Update`, `FixedUpdate`, `LateUpdate`, `OnGUI`, `OnAnimatorIK`, `OnRenderObject` 등)와 코루틴 `while` 루프 내부를 루트 노드로 등록.
2. **클래스 내 콜그래프(Intra-Class Call Graph) 구축 (`CompilationStartAction` → `SemanticModel`)**:
   * 동일 타입(및 `partial class`) 내 모든 메서드의 호출 관계(`IMethodSymbol -> HashSet<IMethodSymbol>`)를 구축한다.
   * BFS로 루트 노드에서 도달 가능한 모든 메서드를 `performanceCriticalMethods` 집합으로 마킹한다(단, 1회성 조건 블록이나 람다/코루틴 외부 콜백은 제외하거나 가중치 처리, 순환 재귀 방지).
3. **진단 발생**:
   * **`UB1001` (Indirect Performance-Critical Invocation)**: `performanceCriticalMethods`에 속하지만 직접적인 이벤트 메서드가 아닌 헬퍼 메서드 내부에서 고비용 API(`GetComponent*`, `FindObjectOfType`, `FindAnyObjectByType`, `GameObject.Find*`, `Camera.main`, `Resources.Load*`, `new WaitForSeconds`)가 호출될 때 호출 지점 및 루트 경로(`Called from Update() -> Move()`)를 메시지로 표시.
   * **`UB1002` (Uncached Component Lookup)**: `Update` 또는 `performanceCriticalMethods` 내부에서 `GetComponent<T>()` / `TryGetComponent<T>(out ...)`가 매 프레임 호출되는 경우 경고.
4. **Quick-Fix (`CacheComponentInAwakeCodeFixProvider`)**:
   * `UB1002` 진단 위치에서 `Ctrl+.` 실행 시:
     1. 클래스 상단에 `private T _cachedT;` (네이밍 충돌 시 번호 부여) 필드 생성.
     2. 클래스에 `Awake()` 메서드가 있으면 첫 줄에 `_cachedT = GetComponent<T>();` 삽입; 없으면 `private void Awake() { _cachedT = GetComponent<T>(); }` 생성. (이미 `Start()`만 있고 `Awake()`가 없는 경우 설정에 따라 `Awake()` 생성)
     3. 호출 지점의 `GetComponent<T>()` 표현식을 `_cachedT`로 교체.

### 3.3 문자열 ID 캐싱 (`UB1003` + `ExtractPropertyToIdCodeFixProvider`)
* **대상 API**:
  * `UnityEngine.Material`: `SetFloat`, `SetInt`, `SetColor`, `SetVector`, `SetTexture`, `SetMatrix`, `Get*`, `HasProperty` (첫 번째 인자가 문자열 리터럴/상수인 경우)
  * `UnityEngine.Animator`: `SetFloat`, `SetInteger`, `SetBool`, `SetTrigger`, `ResetTrigger`, `Get*` (첫 번째 인자가 문자열인 경우)
  * `UnityEngine.Shader`: `SetGlobal*` (첫 번째 인자가 문자열인 경우)
* **진단 조건 (`UB1003`)**: 위 메서드가 `performanceCriticalMethods` 내부에서 호출되거나 동일 클래스 내 2회 이상 동일 문자열로 호출되면 경고 발생.
* **Quick-Fix**:
  * 클래스에 `private static readonly int BaseColorId = Shader.PropertyToID("_BaseColor");` (Animator는 `Animator.StringToHash("...")`) 정적 필드 추가(이미 동일 인자의 `PropertyToID` 필드가 있으면 재사용) 후 문자열 인자를 해당 필드 식별자로 치환.

### 3.4 Burst Compiler 정적 검증기 (`UB2001`~`UB2004`)
`[BurstCompile]` 어트리뷰트가 붙은 `struct`(예: `IJob`, `IJobEntity`, `ISystem`) 또는 `static` 메서드 내부의 `IOperation` 트리를 검사하여 Unity 에디터로 돌아가 컴파일하기 전에 IDE에서 즉시 에러/경고를 띄운다.
* **`UB2001`**: 참조 타입(`ITypeSymbol.IsReferenceType && SpecialType != None` 또는 클래스 인스턴스 필드 접근·할당·생성 `new FooClass()`) 사용 금지 위반. (단, `[BurstDiscard]` 메서드 내부는 예외)
* **`UB2002`**: 값 타입이 `object` 또는 인터페이스 타입으로 암시적/명시적 **Boxing** 변환(`IConversionOperation`에서 `Type.IsReferenceType && Operand.Type.IsValueType`)되는 경우 에러.
* **`UB2003`**: 문자열 연결(`+`), 문자열 보간(`$"..."`), `string.Format` 사용 감지 (단, `Debug.Log` 내부의 상수 문자열이나 `FixedString*` 타입은 허용).
* **`UB2004`**: `try { ... } catch` 또는 `throw` 문 사용 감지 (Burst는 관리되는 예외 처리를 지원하지 않음; 단 `throw`는 Unity 에디터 전용 안전 체크를 위한 패턴을 구분하거나 경고 레벨 제공).

### 3.5 Unity 문자열 리터럴 정합성 검증 (`UB3001`~`UB3003`)
* **`UB3001` (Unresolved Method Name in Invoke/Coroutine)**:
  * `Invoke("Foo", ...)`, `InvokeRepeating("Foo", ...)`, `CancelInvoke("Foo")`, `IsInvoking("Foo")`, `StartCoroutine("Bar")`에서 리터럴 문자열이 현재 클래스(및 상속 부모 클래스)에 존재하지 않거나 `StartCoroutine` 대상의 반환형이 `IEnumerator`가 아닌 경우 경고.
* **`UB3002` (Unknown Tag / Layer)**:
  * `AdditionalFiles`에서 `project-settings.json`을 파싱(`System.Text.Json`)하여 `CompareTag("...")`, `FindWithTag("...")` 인자가 `tags`에 없거나 `LayerMask.NameToLayer("...")`, `LayerMask.GetMask("...")` 인자가 `layers`에 없을 때 경고. (`project-settings.json`이 없는 경우 침묵하여 오탐 방지)
* **`UB3003` (Scene Not in Build Settings)**:
  * `SceneManager.LoadScene("...")`, `LoadSceneAsync("...")` 인자가 `buildScenes` 목록(이름 또는 경로)에 없을 때 경고.

### 3.6 직렬화 필드 보호 (`UB4001` + `FormerlySerializedAsRefactoringProvider`)
* `[SerializeField]` 또는 `MonoBehaviour`/`ScriptableObject`의 `public` 직렬화 가능 필드에 커서가 놓였을 때 `CodeRefactoringProvider`로 **"Rename safely with [FormerlySerializedAs]"** 또는 필드 옆 Quick-Action을 제공한다.
* 필드명을 바꿀 때 기존 필드명이 인자로 들어간 `[UnityEngine.Serialization.FormerlySerializedAs("oldName")]` 어트리뷰트를 자동으로 부착하고 `using UnityEngine.Serialization;`을 추가한다(이미 동일 이름의 `FormerlySerializedAs`가 있으면 중복 추가 방지).

---

## 4. 검증 기준 및 완료 조건 (Verification & Definition of Done)

`analyzers/UnityBrain.Analyzers.Tests`에 `Microsoft.CodeAnalysis.CSharp.Analyzer.Testing.XUnit` 및 `Microsoft.CodeAnalysis.CSharp.CodeFix.Testing.XUnit` 기반 테스트를 작성한다.

1. **콜그래프 테스트 (`UB1001`, `UB1002`)**: `Update() -> StepA() -> StepB() -> GetComponent<Rigidbody>()` 3단계 호출에서 진단을 정확히 보고하고, CodeFix 적용 후 `_rigidbody` 필드와 `Awake()` 초기화 코드가 생성되는지 검증.
2. **PropertyToID 테스트 (`UB1003`)**: `material.SetFloat("_Glossiness", 0.5f)` → `static readonly int Glossiness = Shader.PropertyToID("_Glossiness");` 추출 및 치환 검증.
3. **Burst 테스트 (`UB2001`~`UB2004`)**: `[BurstCompile]` 구조체 내 `string` 보간, `object` 박싱, `class` 할당, `try-catch` 각각에 진단이 발생하고 `[BurstDiscard]` 메서드 내 코드는 무시되는지 검증.
4. **AdditionalFiles 문자열 테스트 (`UB3001`~`UB3003`)**: 테스트용 `project-settings.json`을 `TestState.AdditionalFiles`로 주입해 존재하지 않는 Tag/Scene 경고 및 존재하는 Tag/Scene 무경고를 검증.
5. **실행 명령**: `dotnet test analyzers/UnityBrain.Analyzers.Tests/UnityBrain.Analyzers.Tests.csproj` 전체 Pass.
