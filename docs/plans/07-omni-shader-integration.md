# Sub-Plan 07: Omni Shader Tools 기능 통합 (`shader-advanced-tools`)

> **상위 마스터 문서**: [../../PLAN.md](../../PLAN.md)  
> **선행 조건**: UnityBrain 1.0.0 완료 (`PROGRESS.json` Step 1-1 ~ 7-4 완료, `b9125cc` Shader 지원 업그레이드 반영)  
> **목적**: Rider 수준 구현 완료 이후, VS Code 확장 **Omni Shader Tools for Unity**의 핵심 생산성 기능 중 현재 UnityBrain에 없는 영역을 선별·병합한다.

---

## 1. 현황 점검 및 중복 방지 매트릭스 (Gap Analysis)

UnityBrain은 `packages/shader-lsp`와 `packages/extension/src/shader/shaderEditorProviders.ts`를 통해 이미 Omni Shader Tools의 상당수 기능을 자체 구현한 상태이다. 따라서 **이미 구현된 기능은 재구현하지 않고**, 순수 미구현 갭(Gap)만 통합한다.

| Omni Shader Tools 기능 | UnityBrain 현재 상태 | 통합 필요 여부 | 비고 / 구현 위치 |
| :--- | :--- | :---: | :--- |
| Syntax Highlighting (Unity 6 / SM 6.x) | **완료** | 불필요 | `packages/extension/syntaxes/unity-shaderlab.tmLanguage.json` |
| Outlining / Folding | **완료** | 불필요 | `ShaderFoldingRangeProvider` |
| Document Symbols / Highlight | **완료** | 불필요 | `ShaderDocumentSymbolProvider`, `ShaderDocumentHighlightProvider` |
| Signature Help | **완료** | 불필요 | `ShaderSignatureHelpProvider` |
| Semantic Highlighting | **완료** | 불필요 | `ShaderSemanticTokensProvider` |
| Color Picker (ShaderLab `Color`) | **완료** | 불필요 | `ShaderDocumentColorProvider` |
| Go To Definition (`F12`) | **완료** | 불필요 | `ShaderDefinitionProvider` (`packages/shader-lsp`) |
| Find References / Rename Symbol | **완료** | 불필요 | `ShaderReferenceProvider`, `ShaderRenameProvider` |
| Variant Count / Keyword Context | **완료** | 불필요 | `ShaderKeywordContextStatusBar`, `ShaderVariantCodeLensProvider` |
| **Code Formatting (`.shader`, `.hlsl`)** | **미구현** | **통합 대상** | ShaderLab + HLSL 혼합 포매터 신규 구현 |
| **ShaderLab DSL 자동완성 & Hover** | **부분 구현** | **통합 대상** | `Tags`, `Blend`, `Stencil`, Property Attributes 등 컨텍스트 완성 |
| **Code Snippets (`contributes.snippets`)** | **미구현** | **통합 대상** | URP/HDRP/Built-in/Compute 템플릿 스니펫 추가 |
| **확장 Error Diagnostics** | **부분 구현** | **통합 대상** | 블록 짝 불일치, Property-CBuffer 정합성, HLSL 정적 진단 보강 |
| **Shader Explorer (VS Code TreeView)** | **미구현** | **선택 통합** | 프로젝트 내 셰이더/Pass/키워드/배리언트 한눈에 탐색 |

---

## 2. 통합 범위 및 신규/수정 대상 파일

### 2.1 Step 8-1: ShaderLab + HLSL 혼합 코드 포매터 (`shaderFormatter.ts`)
* **대상 파일**:
  * `packages/extension/src/shader/shaderFormatter.ts` (신규)
  * `packages/extension/src/extension.ts` (`DocumentFormattingEditProvider` / `DocumentRangeFormattingEditProvider` 등록)
  * `packages/extension/package.json` (포매터 옵션 설정 추가: `unityBrain.shader.format.indentSize` 등)
* **핵심 요구사항**:
  * `.shader` 파일 내 **ShaderLab 영역**(`Shader`, `Properties`, `SubShader`, `Pass`, `Tags`, `Stencil`)과 **HLSL/CG 블록**(`HLSLPROGRAM`...`ENDHLSL`, `CGPROGRAM`...`ENDCG`, `HLSLINCLUDE`...`ENDHLSL`)을 구분하여 들여쓰기 및 공백 규칙 적용.
  * 문자열 리터럴(`"..."`), 블록 주석(`/* ... */`), 라인 주석(`// ...`), 전처리기 지시문(`#if`, `#pragma`, `#include`)의 정렬과 보존 보장.
  * 기존 `ShaderFoldingRangeProvider` / `extractVirtualHlslDocument`와 충돌하지 않도록 100% 비파괴적 `TextEdit[]` 반환.

### 2.2 Step 8-2: ShaderLab DSL 컨텍스트 자동완성, Hover 및 스니펫
* **대상 파일**:
  * `packages/shader-lsp/src/providers/completionProvider.ts` (수정: HLSL 블록 외부 ShaderLab 컨텍스트 분기 추가)
  * `packages/shader-lsp/src/providers/hoverProvider.ts` (수정: ShaderLab 키워드/태그/프로퍼티 어트리뷰트 문서 Hover)
  * `packages/extension/snippets/shaderlab.json` (신규)
  * `packages/extension/snippets/hlsl.json` (신규)
  * `packages/extension/package.json` (`contributes.snippets` 등록)
* **핵심 요구사항**:
  * **`Properties` 블록 내부**: `2D`, `3D`, `Cube`, `Color`, `Vector`, `Float`, `Range(min, max)`, `Int`, `Integer` 타입 및 `[HDR]`, `[Normal]`, `[NoScaleOffset]`, `[MainTexture]`, `[MainColor]`, `[Toggle]`, `[Enum(...)]`, `[Space]`, `[Header(...)]` 어트리뷰트 자동완성.
  * **`Tags { ... }` 블록 내부**: `"RenderType"`, `"Queue"`, `"RenderPipeline"="UniversalPipeline"`, `"LightMode"`, `"IgnoreProjector"`, `"DisableBatching"` 등 키/값 자동완성.
  * **렌더 상태 명령어**: `Blend` (`SrcAlpha OneMinusSrcAlpha`, `One One` 등), `BlendOp`, `Cull`, `ZWrite`, `ZTest`, `ColorMask`, `Stencil` (`Ref`, `Comp`, `Pass`, `Fail`, `ZFail`).
  * **스니펫**: URP Lit/Unlit 셰이더 골격, Compute Shader 템플릿, `HLSLPROGRAM`...`ENDHLSL`, `CBUFFER_START(UnityPerMaterial)` 블록 등.

### 2.3 Step 8-3: ShaderLab & HLSL 확장 정적 진단 (Diagnostics)
* **대상 파일**:
  * `packages/extension/src/shader/shaderEditorProviders.ts` (`collectComputeAndShaderLabDiagnostics` 확장)
  * `packages/extension/package.json` (`unityBrain.shader.diagnostics.enabled` 설정 옵션 추가)
* **핵심 요구사항**:
  * 짝이 맞지 않는 블록 태그 검출 (`HLSLPROGRAM` 누락 `ENDHLSL`, `CGPROGRAM` 누락 `ENDCG`, 중괄호 `{}` 불일치).
  * `Properties { _Foo (...) }`에 선언된 프로퍼티와 `CBUFFER_START(UnityPerMaterial)` 내부 변수 간 타입/이름 불일치 경고.
  * `#pragma vertex <fn>` / `#pragma fragment <fn>` 엔트리 포인트 함수 미정의 검출(현재 `kernel`만 검사 중인 로직 확장).

### 2.4 Step 8-4: (선택) VS Code Shader Explorer 뷰 & Variant 리포트
* **대상 파일**:
  * `packages/extension/src/shader/shaderExplorerView.ts` (신규 `TreeDataProvider`)
  * `packages/extension/package.json` (`views` / `viewsContainers` 등록)
* **핵심 요구사항**:
  * 워크스페이스(`Assets/`, `Packages/` 오버라이드) 내 `.shader` / `.compute` 파일을 트리 형태로 표시.
  * 각 셰이더 하위에 `Properties`, `SubShader/Pass`, `#pragma` 키워드 목록, 예상 배리언트 수(128 초과 시 경고 아이콘)를 노출하고 클릭 시 해당 라인으로 즉시 이동.

---

## 3. 검증 기준 (Definition of Done)

1. `node tools/cli.mjs typecheck` 및 `node tools/cli.mjs test shader-lsp`, `node tools/cli.mjs test extension` 100% 통과.
2. 포매터 단위 테스트: 중첩된 `Properties` / `SubShader` / `Pass` / `HLSLPROGRAM` / `#if` 구조가 포함된 `.shader` 파일 포매팅 후 멱등성(2회 연속 실행 시 diff 없음) 검증.
3. ShaderLab 자동완성 및 진단 단위 테스트: `Tags {`, `[HDR]`, `Blend `, 닫히지 않은 `HLSLPROGRAM`, 미정의 `#pragma vertex` 케이스 검증.
