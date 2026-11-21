import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';

export const BEGIN_MARKER = '<!-- UnityBrain:Begin -->';
export const END_MARKER = '<!-- UnityBrain:End -->';

export interface MsbuildInjectorOptions {
  extensionPath: string;
  projectRoot: string;
  cacheDir?: string;
}

export type InjectorResultStatus = 'injected' | 'updated' | 'removed' | 'unchanged';

export class MsbuildAnalyzerInjector {
  private readonly extensionPath: string;
  private readonly projectRoot: string;
  private readonly cacheDir: string;

  constructor(options: MsbuildInjectorOptions) {
    this.extensionPath = path.resolve(options.extensionPath);
    this.projectRoot = path.resolve(options.projectRoot);
    this.cacheDir = path.resolve(
      options.cacheDir ?? path.join(this.projectRoot, 'Library', 'UnityBrainCache'),
    );
  }

  public getPropsFilePath(): string {
    return path.join(this.projectRoot, 'Directory.Build.props');
  }

  private shouldCopyAnalyzerArtifact(srcFile: string, dstFile: string): boolean {
    if (!fs.existsSync(dstFile)) {
      return true;
    }
    try {
      const srcStat = fs.statSync(srcFile);
      const dstStat = fs.statSync(dstFile);
      return (
        srcStat.size !== dstStat.size ||
        Math.floor(srcStat.mtimeMs) !== Math.floor(dstStat.mtimeMs)
      );
    } catch {
      return true;
    }
  }

  private resolveAnalyzerDllPath(): string {
    const sourceDir = path.join(this.extensionPath, 'analyzers');
    const sourceDll = path.join(sourceDir, 'UnityBrain.Analyzers.dll');
    if (!fs.existsSync(sourceDll)) {
      return sourceDll;
    }

    const shadowDir = path.join(os.tmpdir(), 'unitybrain-runtime', 'analyzers');
    const shadowDll = path.join(shadowDir, 'UnityBrain.Analyzers.dll');

    try {
      fs.mkdirSync(shadowDir, { recursive: true });
      const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!/\.(?:dll|pdb)$/i.test(entry.name)) continue;
        const srcFile = path.join(sourceDir, entry.name);
        let isFile = entry.isFile();
        if (!isFile && entry.isSymbolicLink()) {
          try {
            isFile = fs.statSync(srcFile).isFile();
          } catch {
            continue;
          }
        }
        if (!isFile) continue;

        const dstFile = path.join(shadowDir, entry.name);
        if (!this.shouldCopyAnalyzerArtifact(srcFile, dstFile)) continue;

        try {
          const srcStat = fs.statSync(srcFile);
          fs.copyFileSync(srcFile, dstFile);
          fs.utimesSync(dstFile, srcStat.atime, srcStat.mtime);
        } catch {
          // VBCSCompiler may hold lock on shadow copy; reuse existing shadowDll
        }
      }
    } catch {
      // Fall back to existing shadowDll or sourceDll
    }

    return fs.existsSync(shadowDll) ? shadowDll : sourceDll;
  }

  public buildManagedBlock(): string {
    const analyzerDll = this.resolveAnalyzerDllPath();
    const tagManagerAsset = path.join(this.projectRoot, 'ProjectSettings', 'TagManager.asset');
    const buildSettingsAsset = path.join(
      this.projectRoot,
      'ProjectSettings',
      'EditorBuildSettings.asset',
    );
    const unityApiJson = path.join(this.extensionPath, 'resources', 'unity-api.json');

    const escapedAnalyzer = this.escapeMsbuildAndXml(analyzerDll);
    const escapedTagManager = this.escapeMsbuildAndXml(tagManagerAsset);
    const escapedBuildSettings = this.escapeMsbuildAndXml(buildSettingsAsset);
    const escapedUnityApi = this.escapeMsbuildAndXml(unityApiJson);

    return [
      `  ${BEGIN_MARKER}`,
      `  <ItemGroup>`,
      `    <Analyzer Include="${escapedAnalyzer}" Condition="Exists('${escapedAnalyzer}')" />`,
      `    <AdditionalFiles Include="${escapedTagManager}" Condition="Exists('${escapedTagManager}')" />`,
      `    <AdditionalFiles Include="${escapedBuildSettings}" Condition="Exists('${escapedBuildSettings}')" />`,
      `    <AdditionalFiles Include="${escapedUnityApi}" Condition="Exists('${escapedUnityApi}')" />`,
      `  </ItemGroup>`,
      `  ${END_MARKER}`,
    ].join('\n');
  }

  public async ensureInjected(overrideEnabled?: boolean): Promise<InjectorResultStatus> {
    const enabled =
      overrideEnabled ??
      vscode.workspace.getConfiguration('unityBrain').get<boolean>('analyzers.enabled', true);

    if (!enabled) {
      return this.remove();
    }

    const propsPath = this.getPropsFilePath();
    const block = this.buildManagedBlock();

    if (!fs.existsSync(propsPath)) {
      const freshXml = `<Project>\n${block}\n</Project>\n`;
      fs.writeFileSync(propsPath, freshXml, 'utf8');
      return 'injected';
    }

    const existing = fs.readFileSync(propsPath, 'utf8');
    const updated = this.upsertBlockIntoProps(existing, block);

    if (updated === existing) {
      return 'unchanged';
    }

    const hadMarkers = existing.includes(BEGIN_MARKER) && existing.includes(END_MARKER);
    fs.writeFileSync(propsPath, updated, 'utf8');
    return hadMarkers ? 'updated' : 'injected';
  }

  public async remove(): Promise<InjectorResultStatus> {
    const propsPath = this.getPropsFilePath();
    if (!fs.existsSync(propsPath)) {
      return 'unchanged';
    }

    const existing = fs.readFileSync(propsPath, 'utf8');
    const beginIdx = existing.indexOf(BEGIN_MARKER);
    const endIdx = existing.indexOf(END_MARKER);
    if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
      return 'unchanged';
    }

    const lineStart = existing.lastIndexOf('\n', beginIdx);
    const sliceStart = lineStart >= 0 ? lineStart + 1 : beginIdx;
    let sliceEnd = endIdx + END_MARKER.length;
    if (existing[sliceEnd] === '\r') sliceEnd++;
    if (existing[sliceEnd] === '\n') sliceEnd++;

    const stripped = existing.slice(0, sliceStart) + existing.slice(sliceEnd);
    fs.writeFileSync(propsPath, stripped, 'utf8');
    return 'removed';
  }

  private upsertBlockIntoProps(existing: string, block: string): string {
    const beginIdx = existing.indexOf(BEGIN_MARKER);
    const endIdx = existing.indexOf(END_MARKER);

    if (beginIdx !== -1 && endIdx !== -1 && endIdx >= beginIdx) {
      const lineStart = existing.lastIndexOf('\n', beginIdx);
      const replaceStart = lineStart >= 0 ? lineStart + 1 : beginIdx;
      const replaceEnd = endIdx + END_MARKER.length;
      return existing.slice(0, replaceStart) + block + existing.slice(replaceEnd);
    }

    const closeProjectIdx = existing.lastIndexOf('</Project>');
    if (closeProjectIdx !== -1) {
      const prefix = existing.slice(0, closeProjectIdx);
      const needsNewline = prefix.length > 0 && !prefix.endsWith('\n');
      return `${prefix}${needsNewline ? '\n' : ''}${block}\n${existing.slice(closeProjectIdx)}`;
    }

    return `${existing.trimEnd()}\n<Project>\n${block}\n</Project>\n`;
  }

  private escapeMsbuildAndXml(value: string): string {
    // MSBuild special characters MUST be percent-escaped BEFORE XML entities so `&amp;` semicolons stay intact.
    const msbuildEscaped = value
      .replace(/%/g, '%25')
      .replace(/'/g, '%27')
      .replace(/;/g, '%3B')
      .replace(/\$/g, '%24');
    return msbuildEscaped
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
