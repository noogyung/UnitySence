# Sub-Plan 02: ShaderLab & HLSL Language Server (`packages/shader-lsp`)

> **상위 마스터 문서**: [../../PLAN.md](../../PLAN.md)  
> **예상 기간**: Week 3 ~ Week 5 (Phase 2 — 최우선 핵심 차별화 기능)  
> **선행 조건**: [01-core-and-virtual-vfs.md](01-core-and-virtual-vfs.md) (`UnityVirtualPathResolver`, `UnityProjectContext`)

---

## 1. 목적 및 목표 (Purpose & Goal)

### 1.1 목적
VS Code 공식 C#/Unity 확장이 사실상 방치하고 있는 Unity 셰이더(`.shader`, `.hlsl`, `.cginc`, `.compute`, `.urtshader`) 개발 경험을 **JetBrains Rider와 동등한 수준**으로 끌어올린다. 특히 수십 개의 하위 폴더와 `Packages/com.unity.render-pipelines.*` 가상 패키지 경로로 깊게 얽힌 HLSL 파일 간의 **#include 경로 이동 및 함수·구조체·매크로 정의 이동(`F12` / `Ctrl+Click`)**을 지연 없이 제공한다.

### 1.2 목표
1. `.shader`(ShaderLab) 내 `HLSLPROGRAM`/`HLSLINCLUDE`/`CGPROGRAM`/`CGINCLUDE` 블록을 **원본 라인·컬럼 오프셋을 100% 보존한 채** 가상 HLSL 문서로 추출.
2. URP/HDRP/Built-in 셰이더의 특수 매크로(`TEXTURE2D`, `CBUFFER_START`, `SAMPLER` 등)를 표준 파서가 이해할 수 있도록 정규화하는 전처리 프리패스 구축.
3. `#include` 의존성 방향성 비순환 그래프(Include DAG)와 파일별 `HlslSymbolTable`을 구축하여 **교차 파일/폴더 심볼 정의 이동, Hover 시그니처, `#include` 경로 및 심볼 자동완성, 누락 파일/심볼 진단** 제공.
4. `ShaderSymbolIndex`를 Extension에 실시간 제공하여 C# `material.SetFloat("_BaseMap", ...)` 문자열 자동완성(Sub-Plan 03)과 연동.

---

## 2. 생성할 파일 및 심볼 명세

| 파일 경로 | 핵심 Export 심볼 | 역할 |
| :--- | :--- | :--- |
| `packages/shader-lsp/src/server.ts` | `createShaderLanguageServer`, LSP stdio/IPC 진입점 | LSP 생명주기, 파일 감시, Extension과 커스텀 RPC 통신 |
| `packages/shader-lsp/src/parser/shaderLabVirtualDoc.ts` | `extractVirtualHlslDocument`, `parseShaderProperties`, `parseShaderPragmas` | `.shader` → 오프셋 보존 가상 HLSL 문서 변환, `Properties`/`#pragma` 추출 |
| `packages/shader-lsp/src/parser/unityHlslMacroPrepass.ts` | `UnityHlslMacroPrepass` | Unity HLSL 매크로 정규화 및 매크로 정의 테이블 관리 |
| `packages/shader-lsp/src/indexer/hlslIncludeGraph.ts` | `IncludeDependencyGraph` | 재귀적 `#include` DAG 탐색, 순환 참조 방지, 증분 캐시 무효화 |
| `packages/shader-lsp/src/indexer/hlslSymbolTable.ts` | `HlslSymbolTable`, `parseHlslSymbols` | Tree-sitter 기반 함수, 구조체, 필드, 매크로, CBuffer 변수 인덱싱 |
| `packages/shader-lsp/src/providers/definitionProvider.ts` | `ShaderDefinitionProvider` | `#include` 이동, `#pragma vertex/fragment/kernel` 이동, cross-file 심볼 `F12` 이동 |
| `packages/shader-lsp/src/providers/completionProvider.ts` | `ShaderCompletionProvider` | `#include "Packages/..."` 경로 자동완성 및 포함된 심볼·시맨틱·프로퍼티 완성 |
| `packages/shader-lsp/src/providers/hoverProvider.ts` | `ShaderHoverProvider` | 심볼 시그니처, 구조체 멤버, 매크로 원형, 소속 패키지/파일 경로 Hover |

---

## 3. 세부 구현 알고리즘 및 기술 설계

### 3.1 ShaderLab 가상 문서 추출기 (`shaderLabVirtualDoc.ts`)
`.shader` 파일은 C/HLSL 문법과 ShaderLab DSL(`Shader "..." { Properties { ... } SubShader { Pass { ... } } }`)이 혼합되어 있다. 이를 단일 파서로 처리하기 위해 아래 전략을 사용한다.

1. **`extractVirtualHlslDocument(sourceText: string): VirtualHlslExtractionResult`**:
   * `.shader` 텍스트에서 다음 블록 쌍을 스캔한다(중첩 문자열/주석 내부는 무시):
     * `HLSLINCLUDE` ... `ENDHLSL`
     * `HLSLPROGRAM` ... `ENDHLSL`
     * `CGINCLUDE` ... `ENDCG`
     * `CGPROGRAM` ... `ENDCG`
   * **1:1 오프셋 보존(Space Padding)**:
     * 위 코드 블록 외부에 있는 모든 ShaderLab 문자(키워드, 괄호, 프로퍼티 선언 등)는 `\n`과 `\r`을 제외한 **모든 문자를 공백(`' '`)으로 치환**한다.
     * 결과적으로 가상 HLSL 문자열의 모든 라인 번호와 컬럼 오프셋은 원본 `.shader` 파일과 **정확히 1:1 일치**하므로 별도의 복잡한 Source Map 역변환 오차 없이 LSP 위치(`Position`/`Range`)를 그대로 반환할 수 있다.
   * **SubShader `HLSLINCLUDE` 스코프 연결**:
     * 각 `HLSLPROGRAM` 블록은 소속된 `SubShader` (및 Shader 루트) 내의 `HLSLINCLUDE`/`CGINCLUDE` 블록을 암묵적 `#include`와 동일하게 우선 스코프에 포함한다.
2. **`parseShaderProperties(sourceText: string): ShaderPropertyEntry[]`**:
   * `Properties { ... }` 블록 내부를 파싱해 프로퍼티명(`_BaseMap`), 표시명(`"Base Map"`), 타입(`2D`, `Color`, `Float`, `Range(0,1)`, `Vector`, `Integer`), 기본값을 추출한다.
   * 추출된 프로퍼티는 `HlslSymbolTable`에 암시적 전역 심볼로도 등록되어 HLSL 본문에서 `_BaseMap`을 클릭할 때 ShaderLab `Properties` 선언 라인으로 이동할 수 있게 한다.
3. **`parseShaderPragmas(hlslText: string)`**:
   * `#pragma vertex <fnName>`, `#pragma fragment <fnName>`, `#pragma kernel <fnName>`, `#pragma hull <fnName>`, `#pragma domain <fnName>`을 파싱하여 엔트리 포인트 심볼 매핑.
   * `#pragma multi_compile*`, `#pragma shader_feature*` 키워드 그룹 추출 (Sub-Plan 06 상태바 연동용).

### 3.2 Unity HLSL 매크로 전처리 프리패스 (`unityHlslMacroPrepass.ts`)
URP/HDRP의 `.hlsl` 파일은 `TEXTURE2D(_BaseMap);`, `SAMPLER(sampler_BaseMap);`, `CBUFFER_START(UnityPerMaterial)`, `HALF4` 등 표준 C++/HLSL 파서(`tree-sitter-hlsl` 또는 `tree-sitter-cpp`)가 선언문으로 인식하지 못하는 매크로를 대량 사용한다.

1. **매크로 치환 규칙 (길이·줄 수 보존 치환 또는 토큰 매퍼 유지)**:
   * `TEXTURE2D(name)` → `Texture2D name`
   * `TEXTURE2D_X(name)` / `TEXTURE2D_ARRAY(name)` → `Texture2D name`
   * `SAMPLER(name)` → `SamplerState name`
   * `CBUFFER_START(name)` ... `CBUFFER_END` → `cbuffer name {` ... `}`
   * `UNITY_INSTANCING_BUFFER_START(name)` ... `UNITY_INSTANCING_BUFFER_END(name)` → `cbuffer name {` ... `}`
   * `TEXTURE2D_PARAM(tex, smp)` → `Texture2D tex, SamplerState smp`
   * `TEXTURE2D_ARGS(tex, smp)` → `tex, smp`
   * `half`, `half2`, `half3`, `half4`, `real`, `real2`, `real3`, `real4`, `float4x4` 등 HLSL 내장 타입을 파서 내장 타입으로 인식.
2. **오프셋 매핑 보장**:
   * 정규화 과정에서 컬럼 오프셋이 변할 수 있는 경우, 심볼의 `Range`는 항상 **전처리 전 원본 텍스트 기준의 라인·토큰 정규표현식/오프셋 테이블**로 복원해 저장한다.

> **REA (`morluto/rea`) 보조 활용 가이드**:  
> URP/HDRP 버전 업데이트로 문서화되지 않은 Unity 내부 HLSL 확장 매크로나 Rider 전용 내장 키워드 목록이 추가로 필요할 경우, Rider의 `JetBrains.ReSharper.Plugins.Unity.Shaders.dll` 또는 `JetBrains.ReSharper.Psi.Cpp.dll`을 `npx rea-agents`의 .NET 어셈블리 정적 분석 기능으로 검사하여 **매크로 이름과 확장 템플릿 스펙(Clean-Room)**만 추출해 `unityHlslMacroPrepass.ts` 매핑 테이블에 추가한다.

### 3.3 다단계 `#include` 그래프 및 심볼 인덱서 (`hlslIncludeGraph.ts`, `hlslSymbolTable.ts`)
1. **파서 엔진**: `web-tree-sitter` + `tree-sitter-hlsl` (WASM 번들로 네이티브 C++ 컴파일 없이 Win/macOS/Linux 무설정 실행 보장).
2. **`IncludeDependencyGraph`**:
   * 파일 `A`가 열리면 모든 `#include "..."` 및 `#include <...>` 지시문을 추출한다.
   * `UnityVirtualPathResolver`를 호출해 실제 물리 경로(`B`, `C`, ...)를 해석하고 재귀적으로 자식을 파싱한다.
   * **순환 참조 및 중복 방지**: 방문 집합(`visited: Set<string>`)과 글로벌 파일 캐시(`Map<normalizedPath, CachedHlslFile>`)를 유지한다. URP `Core.hlsl` → `Common.hlsl`처럼 수십 개 파일이 깊게 연결되어 있어도 파일당 파싱은 최초 1회(및 수정 시 1회)만 수행한다.
   * **단방향 전파 순서**: C/HLSL 전처리기는 위에서 아래로 `#include`를 평가하므로, 심볼 검색 시 **현재 파일(커서 위쪽) → `#include` DFS 순서(직접 포함 및 간접 포함 파일)** 순으로 심볼을 탐색해 정확한 오버로드·매크로 재정의를 반영한다.
3. **`HlslSymbolTable` 추출 대상**:
   * **함수 정의 및 전방 선언**: 반환형, 함수명, 파라미터 목록, 본문 범위
   * **구조체(`struct`) 및 멤버 필드**: 예) `struct InputData { float3 positionWS; half3 normalWS; ... }` → `inputData.normalWS`와 같은 멤버 접근(`.`) 추적 지원
   * **매크로(`#define`)**: 상수 매크로 및 함수형 매크로(`#define SAMPLE_TEXTURE2D(tex, smp, uv) ...`)의 파라미터와 치환 본문
   * **전역 변수, CBuffer 변수, Texture/Sampler, ShaderLab `Properties`**

### 3.4 LSP 프로바이더 (`definitionProvider.ts`, `completionProvider.ts`, `hoverProvider.ts`)
1. **`ShaderDefinitionProvider` (`textDocument/definition`)**:
   * **케이스 A (`#include` 라인)**: 커서가 `#include "..."` 문자열 위에 있으면 `UnityVirtualPathResolver`로 해석한 물리 파일 URI(라인 0, 컬럼 0) 반환.
   * **케이스 B (`#pragma vertex/fragment/kernel`)**: 커서가 엔트리 함수명 위에 있으면 현재 파일 및 Include 그래프에서 해당 함수 정의 위치 반환.
   * **케이스 C (멤버 접근 `varName.fieldName`)**: `.` 앞의 식별자(`varName`) 타입을 현재 함수 로컬 변수/파라미터/전역 변수 선언에서 추론(예: `SurfaceData surfaceData;` → `SurfaceData`)한 뒤, Include 그래프에서 `struct SurfaceData`의 `fieldName` 선언 위치로 이동.
   * **케이스 D (일반 심볼: 함수 호출, 타입명, 매크로, `_Property`)**: Include 그래프 및 ShaderLab `Properties`에서 일치하는 심볼의 `Location[]` 반환.
2. **`ShaderCompletionProvider` (`textDocument/completion`)**:
   * `#include "` 입력 시 `UnityVirtualPathResolver.listVirtualDirectory()`를 호출하여 `Packages/`, 하위 폴더, `.hlsl`/`.cginc` 파일 경로 자동완성 제공.
   * 코드 본문에서 `varName.` 입력 시 해당 `struct`의 모든 멤버 필드 목록 제안.
   * 일반 타이핑 시 현재 파일 + Include 그래프에 노출된 함수, 구조체, 매크로, ShaderLab 프로퍼티 제안.
3. **`ShaderHoverProvider` (`textDocument/hover`)**:
   * 심볼 위 Hover 시 함수 시그니처 / 구조체 멤버 / `#define` 확장 내용과 함께 출처 가상 경로(예: `Declared in Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl`)를 Markdown 코드 블록으로 표시.
4. **커스텀 LSP Notification/Request**:
   * `unityBrain/getShaderPropertyIndex`: Extension이 호출하면 워크스페이스 내 모든 `.shader`의 `ShaderSymbolIndex.properties` 및 `shaderNames`를 반환한다.
   * `unityBrain/setShaderKeywords`: Sub-Plan 06의 상태바에서 토글한 활성 키워드(`_MAIN_LIGHT_SHADOWS` 등)를 받아 진단/Hover 컨텍스트에 반영한다.

---

## 4. 성능 목표 및 리스크 대응

* **응답 속도**: 캐시된 상태에서 `F12` 정의 이동 및 Hover 응답 `< 50ms`, 최초 URP 프로젝트 Include 그래프 인덱싱 `< 1.5초`.
* **대용량 폴더 대응**: `Library/PackageCache` 전체를 무작정 인덱싱하지 않고, 열려 있거나 프로젝트 `Assets/` 내부 `.shader`/`.hlsl`에서 실제로 `#include`로 참조되는 그래프만 온디맨드로 추적한 뒤 LRU 캐시에 보관한다.

---

## 5. 검증 기준 및 완료 조건 (Verification & Definition of Done)

`packages/shader-lsp`에 `vitest` 기반 LSP 통합 테스트 스위트를 작성하고 아래 항목이 모두 통과해야 한다.

1. **가상 문서 오프셋 테스트**: 여러 `HLSLINCLUDE`, `HLSLPROGRAM` 블록이 섞인 `.shader` 파일에서 추출한 함수·프로퍼티의 라인/컬럼 위치가 원본 `.shader`의 실제 위치와 정확히 일치하는지 검증.
2. **폴더·패키지 `#include` 이동 테스트**:
   * `Assets/Shaders/TestLit.shader`에서 `#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"` 라인에 `DefinitionRequest` 전송 시 `Library/PackageCache/com.unity.render-pipelines.universal@17.0.3/ShaderLibrary/Lighting.hlsl` URI를 반환하는지 검증.
   * `Lighting.hlsl`이 상대/패키지 경로로 다시 `#include "./BRDF.hlsl"`를 포함하는 **3단계 이상 중첩 폴더 구조**에서 `TestLit.shader` 내부 함수 호출에 `DefinitionRequest` 시 `BRDF.hlsl` 내 정확한 선언 라인을 반환하는지 검증.
3. **구조체 멤버 접근 이동 테스트**: `InputData data; data.normalWS`에서 `normalWS`에 `DefinitionRequest` 시 `InputData` 구조체의 `normalWS` 필드 라인을 반환하는지 검증.
4. **성능 테스트**: 50개 중첩 `#include` 픽스처에서 워밍 후 `DefinitionRequest` 평균 지연 `< 50ms` 검증.
5. **실행 명령**: `pnpm --filter @unitybrain/shader-lsp test` 전체 Pass.
