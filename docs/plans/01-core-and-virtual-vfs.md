# Sub-Plan 01: Core Workspace, Unity Virtual VFS & API Extractor

> **상위 마스터 문서**: [../../PLAN.md](../../PLAN.md)  
> **예상 기간**: Week 1 ~ Week 2 (Phase 1)  
> **선행 조건**: 없음 (모든 후속 Sub-Plan의 기반 모듈)

---

## 1. 목적 및 목표 (Purpose & Goal)

### 1.1 목적
VS Code 워크스페이스가 유효한 Unity 프로젝트인지 판별하고, Unity 고유의 가상 경로 체계(`Packages/<pkg-name>/...`, `CGIncludes/...`)를 물리적 디스크 경로로 결정론적으로 해석하며, `JetBrains/resharper-unity`의 Unity API 메타데이터(`api.xml`)를 후속 모듈이 즉시 소비할 수 있는 표준 JSON(`unity-api.json`)으로 변환하는 **기반 인프라를 구축**한다.

### 1.2 목표
1. `pnpm` + `.NET 8` 통합 모노레포 스캐폴딩 및 `schemas/` 기반 공유 계약 생성.
2. Unity 프로젝트 버전(`ProjectVersion.txt`), 에디터 설치 경로(Win/macOS/Linux), 패키지 락(`packages-lock.json`)을 실시간 추적하는 `UnityProjectContextManager` 구현.
3. `Packages/...` 및 빌트인 셰이더 경로를 **100% 정확도로 해석**하는 `UnityVirtualPathResolver` 구현 (Extension과 Shader-LSP 양쪽에서 동일 로직 사용).
4. `tools/api-extractor` CLI를 통해 `api.xml` → `unity-api.json` 변환 자동화.

---

## 2. 생성할 파일 및 심볼 명세

| 파일 경로 | 핵심 Export 심볼 | 역할 |
| :--- | :--- | :--- |
| `package.json` / `pnpm-workspace.yaml` / `UnityBrain.sln` | Workspace & Solution Config | 루트 모노레포 및 .NET 솔루션 구성 |
| `packages/extension/src/contracts/index.ts` | `PLAN.md` §3의 모든 TS 인터페이스 | 공유 계약 타입 단일 진실 공급원 (Shader-LSP에서도 참조 가능하게 `packages/contracts` 또는 상대 재수출 구성) |
| `packages/extension/src/core/unityProjectContext.ts` | `UnityProjectContextManager` | Unity 프로젝트 루트 감지, 에디터 경로 탐색, 파일 감시 및 이벤트 발행 |
| `packages/extension/src/core/virtualPathResolver.ts` | `UnityVirtualPathResolver` | `Packages/...`, `Assets/...`, `CGIncludes/...` → 물리 경로 해석기 |
| `packages/shader-lsp/src/vfs/virtualPathResolver.ts` | `UnityVirtualPathResolver` (미러/공유 래퍼) | LSP 독립 프로세스에서 동작하는 가상 경로 해석기 |
| `tools/api-extractor/src/index.ts` | `extractUnityApiXmlToJson` | `resharper-unity` `api.xml` XML 파서 및 `UnityApiDatabase` JSON 생성기 |
| `packages/extension/resources/unity-api.json` | 생성 산출물 (`UnityApiDatabase`) | 추출된 Unity 이벤트/타입 데이터베이스 |

---

## 3. 세부 구현 알고리즘 및 기술 설계

### 3.1 `UnityProjectContextManager` (`packages/extension/src/core/unityProjectContext.ts`)
1. **프로젝트 루트 탐색**:
   * 워크스페이스 폴더(및 1단계 하위 폴더) 중 `Assets/` 디렉터리와 `ProjectSettings/ProjectVersion.txt`가 동시에 존재하는 디렉터리를 `projectRoot`로 결정한다.
2. **Unity 버전 추출**:
   * `ProjectSettings/ProjectVersion.txt`에서 `m_EditorVersion:\s*([^\r\n]+)` 정규식으로 `editorVersion`을 추출한다 (예: `2022.3.45f1`, `6000.0.23f1`).
3. **Unity Editor 설치 경로 탐색 우선순위**:
   1. VS Code 설정 `unityBrain.unityEditorPath` (사용자가 명시한 경우 최우선)
   2. OS별 Unity Hub 기본 설치 경로 + Hub 설정 JSON (`%APPDATA%/UnityHub/secondaryInstallPath.json` 등) 탐색:
      * **Windows**: `C:\Program Files\Unity\Hub\Editor\{editorVersion}\Editor`
      * **macOS**: `/Applications/Unity/Hub/Editor/{editorVersion}/Unity.app/Contents`
      * **Linux**: `~/Unity/Hub/Editor/{editorVersion}/Editor`
   3. 탐색된 경로에 `Data/CGIncludes` 및 `Data/Resources/PackageManager/BuiltInPackages` 존재 여부를 검증하여 `cgIncludesPath`, `builtInPackagesPath`를 설정한다.
4. **변경 감지**:
   * `Packages/manifest.json`, `Packages/packages-lock.json`, `ProjectSettings/ProjectVersion.txt` 변경 시 `onDidChangeContext` 이벤트를 발생시켜 `shader-lsp`와 `unity-daemon`에 최신 컨텍스트를 전파한다.

### 3.2 `UnityVirtualPathResolver` (`virtualPathResolver.ts`)
Unity 셰이더 및 패키지 파일의 `#include "..."` 또는 가상 경로를 해석할 때 아래 **정확한 우선순위 알고리즘**을 따른다.

```text
입력: virtualOrIncludePath (string), currentFilePath (string), context (UnityProjectContext)
```

1. **정규화**: 역슬래시(`\`)를 `/`로 통일하고 중복 슬래시 제거, 앞뒤 공백 및 따옴표 제거.
2. **패키지 인덱스 테이블 구축 (`refreshPackageMap()`)**:
   * `Packages/packages-lock.json`을 읽고 `dependencies` 객체의 각 항목 `{ [pkgName]: { version, source, ... } }`를 매핑한다.
   * `Packages/manifest.json`의 `dependencies` 중 `file:` 접두사가 있는 로컬 패키지를 보완 매핑한다.
   * **해석 규칙 (우선순위 순)**:
     1. **`Packages/<packageName>/<subpath>` 형태인 경우**:
        * `packages-lock.json`에 항목이 있을 때:
          * `source === "embedded"` → `{projectRoot}/Packages/{packageName}/{subpath}` (존재하지 않으면 `Packages/` 내 각 서브디렉터리의 `package.json` `name` 필드를 스캔해 매칭되는 폴더 사용)
          * `source === "local"` → `version` 필드(`file:...`)를 `{projectRoot}/Packages` 기준 상대/절대 경로로 해석하여 `{resolvedLocalRoot}/{subpath}` 반환
          * `source === "registry"` 또는 `"git"` → `{projectRoot}/Library/PackageCache/{packageName}@{version}/{subpath}` 확인. (Unity 6 해시 폴더명 `<packageName>@<hash>` 대응을 위해 미존재 시 `Library/PackageCache` 디렉터리 내 `{packageName}@*` 프리픽스 폴백 스캔 수행)
          * `source === "builtin"` → `{builtInPackagesPath}/{packageName}/{subpath}` 확인
        * Lock 파일에 없거나 Lock 파일이 부재한 경우:
          * ① `{projectRoot}/Packages/{packageName}/{subpath}`
          * ② `{projectRoot}/Library/PackageCache/{packageName}@*/{subpath}`
          * ③ `{builtInPackagesPath}/{packageName}/{subpath}` 순서로 디스크 존재 여부 체크
     2. **`Assets/<subpath>` 형태인 경우**:
        * `{projectRoot}/Assets/{subpath}`
     3. **상대 경로 또는 일반 파일명 (`"Lighting.hlsl"`, `"../Common.hlsl"`, `"UnityCG.cginc"`)인 경우**:
        * ① 현재 파일의 디렉터리 기준: `path.resolve(path.dirname(currentFilePath), virtualOrIncludePath)`
        * ② 프로젝트 루트 기준: `path.resolve(projectRoot, virtualOrIncludePath)`
        * ③ 빌트인 CGIncludes 기준: `{cgIncludesPath}/{virtualOrIncludePath}`
3. **경로 탐색(Directory Listing) API 제공**:
   * Shader-LSP의 `#include "` 자동완성을 위해 `listVirtualDirectory(virtualPrefix)` 메서드를 제공한다.
   * 예: `listVirtualDirectory("Packages/")` → 설치된 모든 `com.unity.*` 패키지 이름 목록 반환.
   * 예: `listVirtualDirectory("Packages/com.unity.render-pipelines.universal/ShaderLibrary/")` → 실제 물리 폴더의 하위 폴더 및 `.hlsl`/`.cginc` 파일 목록 반환.

> **참조 원본**: `JetBrains/resharper-unity` 저장소의 `resharper/resharper-unity/src/Unity.Shaders/HlslSupport/Integration/Cpp/UnityCgIncludeDirectoryProvider.cs`

### 3.3 `tools/api-extractor` (`extractUnityApiXmlToJson`)
1. **입력 소스**:
   * `JetBrains/resharper-unity`의 `resharper/resharper-unity/src/Unity/api.xml` (CLI 인자 `--input <path>` 또는 로컬 캐시/스냅샷 경로 지정).
2. **XML 파싱 및 변환 규칙**:
   * `fast-xml-parser`를 사용하여 `<api>` → `<type>` → `<message>` 노드를 파싱한다.
   * 각 `<type name="MonoBehaviour" ns="UnityEngine" kind="class" minimumVersion="...">`를 `UnityApiTypeEntry`로 변환한다.
   * 각 `<message name="OnTriggerEnter" static="false" ...>` 내부의 `<parameters>`, `<returns>`, `<summary>`를 추출하여 `UnityEventFunction`으로 정규화한다.
   * `isPerformanceCritical` 플래그: `Update`, `FixedUpdate`, `LateUpdate`, `OnGUI`, `OnAnimatorIK`, `OnAnimatorMove`, `OnRenderObject`, `OnPostRender`, `OnPreRender`에 대해 `true`로 설정한다.
   * `supportsCoroutine` 플래그: `api.xml`의 `coroutine="true"` 속성(또는 `Start`, `OnTriggerEnter`, `OnCollisionEnter` 등 코루틴 가능 이벤트 집합)을 매핑한다.
3. **출력**:
   * `PLAN.md` §3.2의 `UnityApiDatabase` JSON 스키마로 `packages/extension/resources/unity-api.json`에 출력한다.
   * 테스트용 최소 `sample-api.xml` 픽스처를 `tools/api-extractor/test/fixtures/`에 포함해 외부 네트워크 없이도 추출기 단위 테스트가 실행되게 한다.

---

## 4. 검증 기준 및 완료 조건 (Verification & Definition of Done)

AI 에이전트는 구현 완료 후 아래 테스트를 작성하고 모두 통과시켜야 한다.

### 4.1 테스트 픽스처 (`test-fixtures/SampleUnityProject`)
* `ProjectSettings/ProjectVersion.txt` (`m_EditorVersion: 6000.0.23f1`)
* `Packages/manifest.json` & `Packages/packages-lock.json` (`embedded`, `local`, `registry`, `git`, `builtin` 5가지 소스 케이스 모두 포함)
* `Library/PackageCache/com.unity.render-pipelines.universal@17.0.3/ShaderLibrary/Core.hlsl` 및 Unity 6 해시 폴더(`com.unity.render-pipelines.core@a1b2c3d4e5f6/ShaderLibrary/Common.hlsl`)
* 모의 Editor 디렉터리 내 `Data/CGIncludes/UnityCG.cginc`

### 4.2 자동화 테스트 (`vitest`)
1. `UnityProjectContextManager`가 모의 프로젝트에서 `editorVersion`과 `cgIncludesPath`를 정확히 파싱하는지 검증.
2. `UnityVirtualPathResolver`가 5가지 패키지 소스(`embedded`, `local`, `registry` 버전명, Unity 6 해시 폴더, `builtin`) 및 `CGIncludes` 상대 경로를 모두 `physicalPath !== null`로 해석하는지 검증.
3. `packages-lock.json` 수정 시 캐시가 무효화되어 변경된 패키지 경로가 즉시 반영되는지 검증.
4. `extractUnityApiXmlToJson`이 샘플 `api.xml`을 `UnityApiDatabase` 스키마에 100% 부합하는 JSON으로 변환하는지 검증.
5. **실행 명령**: `pnpm --filter @unitybrain/extension test` 및 `pnpm --filter @unitybrain/api-extractor test` 전체 Pass.
