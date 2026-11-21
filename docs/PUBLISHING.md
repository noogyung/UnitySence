# UnitySense VS Code 확장 배포 및 마켓플레이스 출시 가이드

이 문서는 **UnitySense**를 사내 팀 배포(`.vsix` / 사내 GitHub Releases)하거나 **Visual Studio Code Marketplace**에 정식 출시하기 위한 절차를 정리합니다.

---

## 사전 확인 (중요: 사내/외부 PC 호환 빌드 프로파일)

현재 로컬 워크스테이션은 오프라인 `.NET 10` SDK 환경이므로 로컬 `node tools/cli.mjs build` 결과물은 `.NET 10`용으로 컴파일됩니다.
회사 동료 PC(`.NET 8` / `.NET 9` / 구형 Roslyn C# Dev Kit)에서도 동일 VSIX가 동작하려면 **반드시 아래 범용 타겟 옵션으로 빌드한 VSIX**를 배포해야 합니다:

* **Analyzers**: `UseNuGetNetStandard=true` → `netstandard2.0` (`Microsoft.CodeAnalysis.CSharp.Workspaces 4.3.1`)
* **Daemon**: `UseNet8Release=true` → `net8.0` + `rollForward: Major` (`.NET 8 / 9 / 10` 모두 실행 가능)

포함된 GitHub Actions 워크플로([release-vsix.yml](../.github/workflows/release-vsix.yml))는 자동으로 **.NET 8 SDK** 환경에서 두 옵션을 켜고 전체 테스트를 통과한 범용 VSIX를 생성합니다.

---

## 방법 A — 사내 빠른 배포 (팀 내 `.vsix` 공유 / GitHub Release)

마켓플레이스 퍼블리셔 심사 없이 사내에서만 쓰려면 아래 방법 중 하나를 사용합니다.

### 1) 로컬에서 직접 범용 VSIX 생성 (온라인 .NET 8+ SDK PC)
PowerShell에서 아래 변수를 켜고 순차 실행하면 `.NET 8+` / `netstandard2.0` 범용 `dist/unitysense-<version>.vsix`가 생성됩니다:

```powershell
$env:UseNuGetNetStandard = "true"
$env:UseNet8Release = "true"
node tools/cli.mjs build
node tools/cli.mjs test
node tools/cli.mjs package:vsix
```

팀원들은 VS Code에서 `Ctrl+Shift+P` → `Extensions: Install from VSIX...` 또는 `code --install-extension dist/unitysense-1.1.6.vsix`로 즉시 설치할 수 있습니다. (단, 팀원 PC에 `.NET 8.0` 이상의 .NET Runtime과 Microsoft `C#` / `Unity` 확장이 설치되어 있어야 합니다.)

### 2) 사내 GitHub Repository + Tag Release 자동화 (추천)
1. 사내/개인 GitHub 저장소에 현재 코드를 Push합니다.
2. `packages/extension/package.json`의 `"repository"`, `"homepage"`, `"bugs"` URL을 실제 저장소 주소로 변경합니다.
3. 버전을 태그로 Push하면 GitHub Actions가 자동으로 범용 VSIX를 빌드해 **GitHub Releases**에 첨부합니다:
   ```powershell
   git tag v1.1.6
   git push origin v1.1.6
   ```

---

## 방법 B — VS Code Marketplace 정식 출시

공식 VS Code 마켓플레이스에 등록해 팀원들이 VS Code 확장 검색창(`UnitySense`)에서 바로 설치·자동 업데이트받게 하려면 다음 순서를 진행합니다.

### 1단계: Azure DevOps PAT (Personal Access Token) 발급
1. https://dev.azure.com 로그인 후 우측 상단 프로필 메뉴 → **Personal Access Tokens** → **New Token** 클릭.
2. **Organization**: 반드시 **All accessible organizations** 선택.
3. **Scopes**: **Custom defined** → **Show all scopes** → **Marketplace > Manage** 체크 후 생성(토큰 값 복사).

### 2단계: VS Code Marketplace Publisher 생성
1. https://marketplace.visualstudio.com/manage 접속.
2. **Create publisher** 클릭 후 고유한 Publisher ID(예: `mycompany-unity` 또는 개인 ID) 등록.

### 3단계: `packages/extension/package.json` 퍼블리셔·저장소 정보 교체
[packages/extension/package.json](../packages/extension/package.json) 상단의 아래 항목을 실제 값으로 수정합니다:
* `"publisher"`: 2단계에서 만든 Publisher ID로 변경 (현재 플레이스홀더 `"unitysense"`)
* `"repository"`, `"homepage"`, `"bugs"`: 실제 Git 저장소 URL로 변경
*(참고: VS Code Marketplace는 `keywords` 최대 5개 제한이 있으며, 현재 5개로 정렬 완료되어 있습니다.)*

### 4단계: CI 자동 배포 또는 수동 배포

#### 자동 배포 (GitHub Secrets 등록)
1. GitHub 저장소 → **Settings > Secrets and variables > Actions** → **New repository secret**:
   * Name: `VSCE_PAT`
   * Value: 1단계에서 발급한 Azure DevOps PAT
2. 태그 Push (`git tag v1.1.6 && git push origin v1.1.6`) 또는 GitHub Actions 탭에서 `Build & Publish UnitySense VSIX` 워크플로를 `publish_marketplace: true`로 수동 실행합니다.

#### 수동 배포 (`vsce`)
온라인 SDK 환경에서 빌드된 `.vsix` 파일로 직접 게시하려면:

```powershell
npx @vscode/vsce login <YOUR_PUBLISHER_ID>
npx @vscode/vsce publish --packagePath dist/unitysense-1.1.6.vsix
```

> **참고**: 사내 코드를 공개 마켓에 올리지 않고 사내 전용으로만 쓰고 싶다면, Private GitHub Releases 배포(방법 A) 또는 사내 Private Extension Gallery(사내 공유 폴더 / VSIX URL) 방식을 권장합니다.
