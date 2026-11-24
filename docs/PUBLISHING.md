# UnitySense VS Code 확장 배포 및 마켓플레이스 출시 가이드

이 문서는 **UnitySense**를 사내 팀 배포(`.vsix` / 사내 GitHub Releases)하거나 **Visual Studio Code Marketplace**에 정식 출시하기 위한 절차를 정리합니다.

---

## 버전 관리 규칙 (필독)

* `package.json`(루트, `packages/extension`)의 `version`은 **마지막 정식 릴리스 버전**입니다. 개발·테스트 중에는 절대 올리지 않습니다.
* 버전 하나 = Git 태그 `vX.Y.Z` 하나 = GitHub Release 하나 = Open VSX / Marketplace 게시 하나. 한 번 게시한 번호는 다시 쓰지 않습니다.
* SemVer: 새 기능·설정·커맨드·진단 규칙은 MINOR(`1.1.0`), 버그 수정만 있으면 PATCH(`1.1.1`), 설정/커맨드 삭제·이름 변경은 MAJOR(`2.0.0`).
* 다음 릴리스에 들어갈 변경사항은 `CHANGELOG.md`의 `## [Unreleased]`에 기록합니다.

### 로컬 테스트 빌드 (버전 변경 없음)

```powershell
node tools/cli.mjs build:extension
node tools/cli.mjs package:vsix:dev
```

* 소스 버전은 그대로 두고, VSIX 안에만 `x.y.(z+1)-dev.<YYYYMMDDHHmmss>` 버전을 넣어 `dist/dev/`에 만듭니다. (예: 소스 `1.1.0` → `1.1.1-dev.20261125153012`)
* 빌드할 때마다 버전이 커지므로 덮어 설치해도 충돌이 없고, 다음 정식 릴리스가 마켓에 올라오면 IDE가 자동으로 정식 버전으로 업데이트합니다.
* 개발 버전은 CI가 게시를 막습니다.

### 정식 릴리스 절차

```powershell
node tools/cli.mjs release:prepare 1.2.0
git add -A
git commit -m "release: v1.2.0"
git push origin master
git tag v1.2.0
git push origin v1.2.0
```

* `release:prepare`는 두 `package.json`의 버전을 바꾸고, `CHANGELOG.md`의 `## [Unreleased]` 내용을 `## [1.2.0] - <오늘 날짜>` 섹션으로 옮깁니다. 커밋·태그·푸시는 하지 않습니다.
* 태그가 푸시되면 CI가 `node tools/cli.mjs verify:release-tag vX.Y.Z`로 태그, `package.json` 버전, CHANGELOG 섹션이 모두 일치하는지 확인한 뒤 빌드·테스트·게시합니다. 하나라도 다르면 게시하지 않습니다.

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

팀원들은 VS Code에서 `Ctrl+Shift+P` → `Extensions: Install from VSIX...` 또는 `code --install-extension dist/unitysense-1.0.0.vsix`로 즉시 설치할 수 있습니다. (단, 팀원 PC에 `.NET 8.0` 이상의 .NET Runtime과 Microsoft `C#` / `Unity` 확장이 설치되어 있어야 합니다.)

### 2) GitHub Repository + Tag Release 자동화 (추천)
1. [https://github.com/noogyung/UnitySense](https://github.com/noogyung/UnitySense) 저장소에 현재 코드를 Push합니다.
2. 버전을 태그로 Push하면 GitHub Actions가 자동으로 범용 VSIX를 빌드해 **GitHub Releases**에 첨부합니다:
   ```powershell
   git tag v1.0.0
   git push origin v1.0.0
   ```

---

## 방법 B — VS Code Marketplace 정식 출시

공식 VS Code 마켓플레이스에 등록해 VS Code 확장 검색창(`UnitySense`)에서 바로 설치·자동 업데이트받게 하려면 다음 순서를 진행합니다.

### 1단계: Azure DevOps PAT (Personal Access Token) 발급 (CI 자동 배포 시에만 필요)
1. https://dev.azure.com 로그인 후 우측 상단 프로필 메뉴 → **Personal Access Tokens** → **New Token** 클릭.
2. **Organization**: 반드시 **All accessible organizations** 선택.
3. **Scopes**: **Custom defined** → **Show all scopes** → **Marketplace > Manage** 체크 후 생성(토큰 값 복사).

### 2단계: VS Code Marketplace Publisher 생성
1. https://marketplace.visualstudio.com/manage 접속 (개인 Microsoft 계정만으로 무료 가능).
2. **Create publisher** 클릭 후 `NoogKim` Publisher 등록 (웹 UI 직접 업로드 시 1단계 PAT 없이도 `+ New extension > Visual Studio Code`로 `.vsix` 업로드 가능).

### 3단계: `packages/extension/package.json` 확인
[packages/extension/package.json](../packages/extension/package.json)에 아래와 같이 설정되어 있습니다:
* `"publisher"`: `"NoogKim"` (실제 Marketplace에서 등록한 Publisher ID와 정확히 일치해야 함)
* `"repository"`, `"homepage"`, `"bugs"`: `https://github.com/noogyung/UnitySense`
*(참고: VS Code Marketplace는 `keywords` 최대 5개 제한이 있으며, 현재 5개로 정렬 완료되어 있습니다.)*

### 4단계: CI 자동 배포 또는 수동 배포

#### 자동 배포 (GitHub Secrets 등록)
1. GitHub 저장소 → **Settings > Secrets and variables > Actions** → **New repository secret**:
   * Name: `VSCE_PAT`
   * Value: 1단계에서 발급한 Azure DevOps PAT
2. 태그 Push (`git tag v1.0.0 && git push origin v1.0.0`) 또는 GitHub Actions 탭에서 `Build & Publish UnitySense VSIX` 워크플로를 `publish_marketplace: true`로 수동 실행합니다.

#### 수동 배포 (`vsce`)
온라인 SDK 환경에서 빌드된 `.vsix` 파일로 직접 게시하려면:

```powershell
npx @vscode/vsce login NoogKim
npx @vscode/vsce publish --packagePath dist/unitysense-1.0.0.vsix
```

> **참고**: 사내 코드를 공개 마켓에 올리지 않고 사내 전용으로만 쓰고 싶다면, Private GitHub Releases 배포(방법 A) 또는 사내 Private Extension Gallery(사내 공유 폴더 / VSIX URL) 방식을 권장합니다.

---

## 방법 C — Open VSX Registry 출시 (Antigravity IDE / Cursor / Windsurf 지원)

**Antigravity IDE**를 포함한 VS Code 포크 IDE들은 기본 확장 마켓으로 **Open VSX Registry (`open-vsx.org`)** 를 사용합니다. Open VSX에 동시 배포하면 Antigravity IDE 확장 검색창에서 `UnitySense`를 바로 검색·설치·자동 업데이트할 수 있습니다.

### 1단계: Open VSX 계정 및 네임스페이스 등록
1. https://open-vsx.org 에 GitHub 계정으로 로그인하고 Eclipse Publisher Agreement에 동의합니다.
2. 프로필 → **Access Tokens** → **Generate New Token**으로 `OVSX_PAT` 토큰을 발급합니다.
3. 최초 1회 네임스페이스(`noogkim`)를 생성합니다:
   ```powershell
   npx --yes ovsx create-namespace noogkim -p <OVSX_PAT>
   ```

### 2단계: CI 자동 배포 또는 수동 배포
* **자동 배포**: GitHub 저장소 → **Settings > Secrets and variables > Actions** → `OVSX_PAT` 시크릿을 등록하면, 릴리스 태그 Push(위 "정식 릴리스 절차") 또는 워크플로 수동 실행(`publish_openvsx: true`) 시 VS Code Marketplace와 Open VSX에 동시 게시됩니다.
* **수동 배포**:
  ```powershell
  npx --yes ovsx publish dist/unitysense-<version>.vsix -p <OVSX_PAT>
  ```
* **오프라인 VSIX 직접 설치 (Antigravity IDE)**:
  * Antigravity IDE에서 `Ctrl+Shift+P` → **`Extensions: Install from VSIX...`** → `dist/unitysense-<version>.vsix` 선택

