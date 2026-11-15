# Sub-Plan 05: .NET 8 YAML Asset Indexer Daemon & CodeLens (`packages/unity-daemon`)

> **상위 마스터 문서**: [../../PLAN.md](../../PLAN.md)  
> **예상 기간**: Week 11 (Phase 5)  
> **선행 조건**: [01-core-and-virtual-vfs.md](01-core-and-virtual-vfs.md) (`UnityProjectContext`)

---

## 1. 목적 및 목표 (Purpose & Goal)

### 1.1 목적
JetBrains Rider가 C# 코드 에디터 상단에서 보여주는 **"3 Asset Usages (1 Scene, 2 Prefabs)"**, **"UnityEvent Callback Usage"**, **"Inspector에서 덮어쓴 필드 값 표시"** 기능을 VS Code Extension Host(단일 스레드 Node.js)의 성능 저하 없이 구현한다. 대용량 `.unity` 및 `.prefab` YAML 파일 수천 개를 빠르게 스트리밍 파싱하기 위해 **.NET 8 독립 백그라운드 데몬(`unity-daemon`)**으로 분리한다.

### 1.2 목표
1. JSON-RPC 2.0 over stdio로 통신하는 경량 `.NET 8` 데몬 프로세스 구축 (`packages/unity-daemon`).
2. 범용 YAML DOM 파서 대신 **초고속 라인 단위 상태 머신 스트리밍 파서(`UnityYamlStreamParser`)** 구현으로 1,000개 프리팹/씬 인덱싱 `< 500ms` 달성.
3. `Library/UnityBrainCache/asset-index.bin` 바이너리 캐시 및 파일 타임스탬프 기반 증분 업데이트로 재실행 시 `< 500ms` 웜 스타트 달성.
4. VS Code `CodeLensProvider`에서 C# 스크립트 클래스, `[SerializeField]`/`public` 필드, UnityEvent 콜백 메서드 위에 사용처 수 및 Inspector 값 표시 + 클릭 시 Scene/Prefab 내 정확한 GameObject 계층 경로로 이동하는 QuickPick UI 제공.

---

## 2. 생성할 파일 및 심볼 명세

| 파일 경로 | 핵심 Export / 클래스 심볼 | 역할 |
| :--- | :--- | :--- |
| `packages/unity-daemon/UnityBrain.Daemon.csproj` | `.NET 8.0` 콘솔/AOT 호환 프로젝트 | 독립 실행형 데몬 빌드 정의 |
| `packages/unity-daemon/Program.cs` | `Program.Main` | CLI 인자(`--project-root`, `--cache-dir`) 파싱, 초기화 및 `RpcServer` 시작 |
| `packages/unity-daemon/RpcServer.cs` | `RpcServer` | stdio JSON-RPC 2.0 디스패처 (`PLAN.md` §3.5 규약 준수) |
| `packages/unity-daemon/Indexing/MetaGuidMap.cs` | `MetaGuidMap` | `Assets/**/*.cs.meta` 및 `Packages/**/*.cs.meta` ↔ GUID 양방향 맵 |
| `packages/unity-daemon/Indexing/UnityYamlStreamParser.cs` | `UnityYamlStreamParser` | 무할당(Span/StreamReader) 상태 머신 기반 `.unity`/`.prefab`/`.asset` 파서 |
| `packages/unity-daemon/Cache/BinaryIndexCache.cs` | `BinaryIndexCache` | 인덱스 스냅샷 및 파일별 `(LastWriteUtc, FileSize)` 직렬화/복원 |
| `packages/extension/src/codelens/unityAssetUsageCodeLensProvider.ts` | `UnityAssetUsageCodeLensProvider`, `UnityDaemonClient` | 데몬 프로세스 생명주기 관리, CodeLens 제공 및 클릭 QuickPick 액션 |

---

## 3. 세부 구현 알고리즘 및 기술 설계

### 3.1 `MetaGuidMap` (`Indexing/MetaGuidMap.cs`)
1. `Assets/`와 로컬/임베디드 `Packages/` 내 모든 `*.cs.meta` 및 `*.asset.meta` 파일을 병렬 스캔(`Parallel.ForEachAsync` 또는 `EnumerationOptions`).
2. 각 `.meta` 파일의 첫 5줄 내에서 `guid:\s*([0-9a-fA-F]{32})` 라인을 읽어 `GuidToScriptPath` 및 `ScriptPathToGuid` 사전을 구축한다.
3. Extension이 C# 파일 저장·이동 이벤트를 전달하거나 데몬 자체 `FileSystemWatcher`가 `.meta` 변경을 감지하면 해당 엔트리만 즉시 갱신한다.

### 3.2 고성능 스트리밍 파서 (`UnityYamlStreamParser.cs`)
Unity 씬/프리팹 YAML은 단일 파일 크기가 수십 MB에 달할 수 있으므로 전체 트리를 메모리에 올리는 `YamlDotNet` DOM 파싱을 금지한다. 대신 `StreamReader` + `ReadOnlySpan<char>` 라인 상태 머신으로 1-Pass 스캔한다.

1. **YAML 문서 경계 식별**:
   * `--- !u!<classID> &<fileID>` 헤더를 만날 때마다 현재 문서 컨텍스트를 전환한다.
     * `!u!1` (`GameObject`): `m_Name` 추출 → `Dictionary<string fileId, string name>` 저장.
     * `!u!4` / `!u!224` (`Transform` / `RectTransform`): `m_GameObject: {fileID: ...}`, `m_Father: {fileID: ...}`, `m_Children` 추출 → 1-Pass 종료 후 O(N) 부모 역추적으로 전체 계층 경로(`"Canvas/HUD/PlayerHealthBar"`) 조립.
     * `!u!114` (`MonoBehaviour`):
       * `m_GameObject: {fileID: <goId>}` 매핑.
       * `m_Script: {fileID: 11500000, guid: <guid>, type: 3}` 추출 → `MetaGuidMap`에 등록된 사용자 스크립트 GUID인 경우에만 하위 필드 수집 모드로 진입 (Unity 내장 패키지 컴포넌트가 아닌 경우라도 인덱싱 가능하지만 기본 대상은 프로젝트 스크립트 GUID).
       * **직렬화 스칼라 필드 추출**: 표준 헤더 필드(`m_ObjectHideFlags`, `m_CorrespondingSourceObject`, `m_PrefabInstance`, `m_PrefabAsset`, `m_GameObject`, `m_Enabled`, `m_EditorHideFlags`, `m_Script`, `m_Name`, `m_EditorClassIdentifier`) 이후 등장하는 사용자 필드(`moveSpeed: 5.5`, `maxHp: 100` 등)의 `fieldName -> rawValue` 수집.
       * **UnityEvent 콜백 추출 (`m_PersistentCalls`)**: `m_Target: {fileID: <targetComponentId>}` 및 `m_MethodName: <methodName>` 쌍을 추출하여 해당 타깃 컴포넌트의 `m_Script` GUID와 연결 → `usageKind: 'unityEventCallback'`로 인덱싱.
     * `!u!1001` (`PrefabInstance`): 프리팹 오버라이드(`m_Modifications` 내 `propertyPath`, `value`) 추출.

### 3.3 바이너리 증분 캐시 (`BinaryIndexCache.cs`)
* 캐시 파일 위치: `{projectRoot}/Library/UnityBrainCache/asset-index.bin`
* 저장 구조:
  * Header (Magic `"UBIX"`, SchemaVersion `1`)
  * `FileManifest`: `Dictionary<string relativePath, (long lastWriteTicks, long length)>`
  * `IndexedRecords`: 파일별 추출된 `MonoBehaviour` 레코드 목록
* **웜 스타트 알고리즘**:
  1. 데몬 시작 시 `asset-index.bin` 로드 (`< 50ms`).
  2. 디스크의 `.unity`/`.prefab`/`.asset` 목록과 `FileManifest` 비교 → 변경/추가된 파일만 `UnityYamlStreamParser`로 재파싱, 삭제된 파일은 제거.
  3. 작업 완료 후 `notification/indexProgress` (`ready: true`) 알림 전송 및 비동기로 `asset-index.bin` 갱신 저장.

### 3.4 VS Code CodeLens & QuickPick (`unityAssetUsageCodeLensProvider.ts`)
1. **`UnityDaemonClient`**:
   * `packages/extension` 활성화 시 번들된 `unity-daemon` 실행 파일을 `child_process.spawn`으로 구동하고 `vscode-jsonrpc`로 stdio 연결.
   * 비정상 종료 시 지수 백오프(최대 3회)로 자동 재시작.
2. **CodeLens 표시 위치**:
   * **클래스 선언 라인 (`MonoBehaviour` / `ScriptableObject`)**:
     * `usage/findByScriptGuid` 호출 → `N Asset Usages (X Scenes, Y Prefabs)` CodeLens 표시 (0건이면 `No Asset Usages`).
   * **직렬화 필드 라인 (`[SerializeField]` 또는 `public` 필드)**:
     * `inspector/getSerializedValues` 호출 → 단일 값/소수 값인 경우 `Inspector: 5.5` (또는 다수 프리팹에서 값이 다르면 `3 Prefab Values...`) CodeLens 표시.
   * **메서드 선언 라인 (public 또는 `[SerializeField]` 이벤트 대상 가능 메서드)**:
     * `usage/findByMethod` 호출 → `M UnityEvent Usages` (1건 이상일 때만 표시).
3. **클릭 액션 (`unityBrain.showAssetUsages`)**:
   * CodeLens 클릭 시 `vscode.window.showQuickPick`으로 목록(`$(file) Stage01.unity — Canvas/HUD/PlayerHealthBar [moveSpeed = 5.5]`)을 띄운다.
   * 항목 선택 시 해당 `.unity`/`.prefab` 파일을 해당 `fileID` 라인으로 열어주거나, 설정에 따라 Unity Editor에 Ping 요청을 보낼 수 있도록 확장 포인트를 둔다.

---

## 4. 검증 기준 및 완료 조건 (Verification & Definition of Done)

`packages/unity-daemon`에 xUnit 단위 테스트 및 성능 벤치마크 테스트 프로젝트를 작성하고 아래 항목이 모두 통과해야 한다.

1. **YAML 스트리밍 파서 정확도 테스트**:
   * 중첩된 `GameObject` + `Transform`/`RectTransform` 계층(`Parent/Child/Leaf`), `MonoBehaviour`의 `m_Script` GUID, 스칼라 필드, `m_PersistentCalls` (`m_MethodName`)가 모두 정확히 추출되는지 검증.
2. **1,000개 에셋 벤치마크 테스트**:
   * 테스트 코드에서 1,000개의 합성 `.prefab` 및 `.unity` 파일(각 파일당 수십 개 GameObject 포함)을 생성해 풀 인덱싱을 실행하고 총 소요 시간이 **`< 500ms`** 이내인지 검증 (`Stopwatch` assertion).
3. **증분 캐시 웜 스타트 테스트**:
   * 캐시 저장 후 1개 파일만 수정하고 재시작 시 수정된 1개 파일만 재파싱되며 전체 로딩 시간이 `< 150ms` 이내인지 검증.
4. **JSON-RPC 프로토콜 E2E 테스트**:
   * stdio 파이프를 통해 `index/status`, `usage/findByScriptGuid`, `usage/findByMethod`, `inspector/getSerializedValues` 요청을 보내 스키마(`PLAN.md` §3.5)와 일치하는 JSON 응답을 받는지 검증.
5. **실행 명령**: `dotnet test packages/unity-daemon/` 및 `pnpm --filter @unitybrain/extension test` 전체 Pass.
