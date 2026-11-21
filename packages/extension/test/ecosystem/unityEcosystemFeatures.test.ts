import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { UnityAsmdefProvider } from '../../src/asmdef/unityAsmdefProvider.ts';
import {
  generateUnityLaunchConfig,
  openAssetInUnityEditor,
  readEditorInstance,
  resolveUnityEditorLogPath,
} from '../../src/editor/unityEditorIntegration.ts';
import {
  collectUiToolkitElements,
  UnityUssCompletionProvider,
  UnityUxmlDefinitionProvider,
} from '../../src/uitoolkit/unityUiToolkitProvider.ts';

const tempDirs: string[] = [];

function createTempProject(): string {
  const dir = path.join(
    process.cwd(),
    'test-output',
    `ext-ecosystem-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.mkdirSync(path.join(dir, 'Assets', 'Scripts', 'Core'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Assets', 'Scripts', 'Gameplay'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Assets', 'UI'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Library'), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vscode.__mock.reset();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Unity Ecosystem Features (Asmdef, UI Toolkit, Editor Integration)', () => {
  it('provides .asmdef InlayHints, F12 Definition, Completion, and cycle diagnostics', () => {
    const root = createTempProject();
    const coreAsm = path.join(root, 'Assets', 'Scripts', 'Core', 'Game.Core.asmdef');
    const gameAsm = path.join(root, 'Assets', 'Scripts', 'Gameplay', 'Game.Gameplay.asmdef');
    const coreGuid = '11112222333344445555666677778888';
    const gameGuid = '9999aaaabbbbccccddddeeeeffff0000';

    fs.writeFileSync(
      coreAsm,
      JSON.stringify({ name: 'Game.Core', references: [`GUID:${gameGuid}`] }, null, 2),
      'utf8',
    );
    fs.writeFileSync(`${coreAsm}.meta`, `fileFormatVersion: 2\nguid: ${coreGuid}\n`, 'utf8');

    const gameContent = JSON.stringify(
      {
        name: 'Game.Gameplay',
        references: [`GUID:${coreGuid}`, 'GUID:deadbeefdeadbeefdeadbeefdeadbeef'],
        includePlatforms: [],
      },
      null,
      2,
    );
    fs.writeFileSync(gameAsm, gameContent, 'utf8');
    fs.writeFileSync(`${gameAsm}.meta`, `fileFormatVersion: 2\nguid: ${gameGuid}\n`, 'utf8');

    const provider = new UnityAsmdefProvider(root);
    const doc = vscode.__mock.createTextDocument(vscode.Uri.file(gameAsm), gameContent, 'json');

    // InlayHints
    const hints = provider.provideInlayHints(doc);
    expect(hints.some((h) => h.label === ' → Game.Core')).toBe(true);

    // Definition
    const guidIdx = gameContent.indexOf(coreGuid);
    const defLoc = provider.provideDefinition(doc, doc.positionAt(guidIdx));
    expect(path.resolve(defLoc!.uri.fsPath)).toBe(path.resolve(coreAsm));

    // Completion (references + platforms) auto-quotes JSON values when outside quotes
    const refPos = doc.positionAt(gameContent.indexOf('"references": [') + '"references": ['.length);
    const refItems = provider.provideCompletionItems(doc, refPos);
    const coreRefItem = refItems?.find((i) => i.label === 'Game.Core');
    expect(coreRefItem).toBeDefined();
    expect(coreRefItem?.insertText).toBe('"Game.Core"');
    expect(refItems?.map((i) => i.label)).toContain(`GUID:${coreGuid}`);

    const platPos = doc.positionAt(
      gameContent.indexOf('"includePlatforms": [') + '"includePlatforms": ['.length,
    );
    const platItems = provider.provideCompletionItems(doc, platPos);
    expect(platItems?.find((i) => i.label === 'Editor')?.insertText).toBe('"Editor"');
    expect(platItems?.map((i) => i.label)).toContain('WindowsStandalone64');

    // Diagnostics (unresolved GUID + cycle)
    const diags = provider.validateDocument(doc);
    expect(diags.some((d) => d.message.includes('deadbeef'))).toBe(true);
    expect(diags.some((d) => d.message.includes('순환 어셈블리 참조'))).toBe(true);
  });

  it('indexes UXML/USS elements and completes Unity USS properties, pseudo-states, and classes', () => {
    const root = createTempProject();
    const uxmlPath = path.join(root, 'Assets', 'UI', 'Hud.uxml');
    const ussPath = path.join(root, 'Assets', 'UI', 'Hud.uss');

    fs.writeFileSync(
      uxmlPath,
      [
        '<ui:UXML>',
        '  <ui:Button name="StartBtn" class="primary-btn hud-control" />',
        '</ui:UXML>',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(ussPath, '.banner-box {\n  color: #ffffff;\n}\n', 'utf8');

    const elements = collectUiToolkitElements(root);
    expect(elements.some((e) => e.name === 'StartBtn')).toBe(true);
    expect(elements.some((e) => e.className === 'primary-btn')).toBe(true);
    expect(elements.some((e) => e.className === 'banner-box')).toBe(true);

    const ussProvider = new UnityUssCompletionProvider(() => elements);

    const propDoc = vscode.__mock.createTextDocument(vscode.Uri.file(ussPath), 'Button {\n  -unity-', 'uss');
    const propItems = ussProvider.provideCompletionItems(propDoc, new vscode.Position(1, 9));
    expect(propItems?.map((i) => i.label)).toContain('-unity-font-definition');

    const pseudoDoc = vscode.__mock.createTextDocument(vscode.Uri.file(ussPath), '.primary-btn:', 'uss');
    const pseudoItems = ussProvider.provideCompletionItems(pseudoDoc, new vscode.Position(0, 13));
    expect(pseudoItems?.map((i) => i.label)).toContain('hover');

    const clsDoc = vscode.__mock.createTextDocument(vscode.Uri.file(ussPath), '.', 'uss');
    const clsItems = ussProvider.provideCompletionItems(clsDoc, new vscode.Position(0, 1));
    expect(clsItems?.map((i) => i.label)).toContain('primary-btn');
  });

  it('indexes Library/PackageCache .asmdef packages (e.g. Unity.InputSystem) and prioritizes workspace Packages/ overrides', () => {
    const root = createTempProject();
    const inputAsmDir = path.join(
      root,
      'Library',
      'PackageCache',
      'com.unity.inputsystem@1.11.2',
      'InputSystem',
    );
    fs.mkdirSync(inputAsmDir, { recursive: true });
    const inputAsmPath = path.join(inputAsmDir, 'Unity.InputSystem.asmdef');
    const inputGuid = 'aaaa1111bbbb2222cccc3333dddd4444';
    fs.writeFileSync(
      inputAsmPath,
      JSON.stringify({ name: 'Unity.InputSystem', references: [] }, null, 2),
      'utf8',
    );
    fs.writeFileSync(`${inputAsmPath}.meta`, `fileFormatVersion: 2\nguid: ${inputGuid}\n`, 'utf8');

    // Embedded package in Packages/ should take precedence over duplicate in Library/PackageCache
    const embeddedDir = path.join(root, 'Packages', 'com.unity.mathematics', 'Unity.Mathematics');
    const cachedDupDir = path.join(
      root,
      'Library',
      'PackageCache',
      'com.unity.mathematics@1.3.2',
      'Unity.Mathematics',
    );
    fs.mkdirSync(embeddedDir, { recursive: true });
    fs.mkdirSync(cachedDupDir, { recursive: true });
    const embeddedMathAsm = path.join(embeddedDir, 'Unity.Mathematics.asmdef');
    const cachedMathAsm = path.join(cachedDupDir, 'Unity.Mathematics.asmdef');
    const mathGuid = '12341234123412341234123412341234';
    fs.writeFileSync(embeddedMathAsm, JSON.stringify({ name: 'Unity.Mathematics' }), 'utf8');
    fs.writeFileSync(`${embeddedMathAsm}.meta`, `fileFormatVersion: 2\nguid: ${mathGuid}\n`, 'utf8');
    fs.writeFileSync(cachedMathAsm, JSON.stringify({ name: 'Unity.Mathematics' }), 'utf8');
    fs.writeFileSync(
      `${cachedMathAsm}.meta`,
      'fileFormatVersion: 2\nguid: 56785678567856785678567856785678\n',
      'utf8',
    );

    const playerAsm = path.join(root, 'Assets', 'Scripts', 'Gameplay', 'Game.Player.asmdef');
    const playerContent = JSON.stringify(
      {
        name: 'Game.Player',
        references: [`GUID:${inputGuid}`, 'Unity.Mathematics'],
      },
      null,
      2,
    );
    fs.writeFileSync(playerAsm, playerContent, 'utf8');

    const provider = new UnityAsmdefProvider(root);
    const doc = vscode.__mock.createTextDocument(vscode.Uri.file(playerAsm), playerContent, 'json');

    // InlayHints resolve PackageCache GUID -> Unity.InputSystem
    const hints = provider.provideInlayHints(doc);
    expect(hints.some((h) => h.label === ' → Unity.InputSystem')).toBe(true);

    // F12 Definition resolves PackageCache GUID and embedded override
    const inputDef = provider.provideDefinition(doc, doc.positionAt(playerContent.indexOf(inputGuid)));
    expect(path.resolve(inputDef!.uri.fsPath)).toBe(path.resolve(inputAsmPath));

    const mathDef = provider.provideDefinition(
      doc,
      doc.positionAt(playerContent.indexOf('Unity.Mathematics')),
    );
    expect(path.resolve(mathDef!.uri.fsPath)).toBe(path.resolve(embeddedMathAsm));

    // Completion lists PackageCache assemblies without duplicate entries for overridden packages
    const refPos = doc.positionAt(
      playerContent.indexOf('"references": [') + '"references": ['.length,
    );
    const refItems = provider.provideCompletionItems(doc, refPos) ?? [];
    expect(refItems.map((i) => i.label)).toContain('Unity.InputSystem');
    expect(refItems.map((i) => i.label)).toContain(`GUID:${inputGuid}`);
    expect(refItems.filter((i) => i.label === 'Unity.Mathematics').length).toBe(1);

    // No false unresolved-GUID warning for PackageCache assembly
    const diags = provider.validateDocument(doc);
    expect(diags.length).toBe(0);
  });

  it('completes Unity 6 Flexbox/layout USS properties, indexes PackageCache UI Toolkit files, and resolves UXML definitions', () => {
    const root = createTempProject();
    const uiDir = path.join(root, 'Assets', 'UI');
    const templatesDir = path.join(uiDir, 'Templates');
    const pkgUiDir = path.join(root, 'Library', 'PackageCache', 'com.unity.ui.theme@1.0.0', 'Styles');
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.mkdirSync(pkgUiDir, { recursive: true });

    const uxmlPath = path.join(uiDir, 'MainHud.uxml');
    const ussPath = path.join(uiDir, 'MainHud.uss');
    const templatePath = path.join(templatesDir, 'ItemCard.uxml');
    const pkgUssPath = path.join(pkgUiDir, 'PkgTheme.uss');

    fs.writeFileSync(
      ussPath,
      [
        '.primary-btn {',
        '  flex-direction: row;',
        '}',
        '',
        '.hud-control {',
        '  justify-content: center;',
        '}',
        '',
        '#StartBtn {',
        '  opacity: 0.95;',
        '}',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(templatePath, '<ui:UXML><ui:Label text="Card" /></ui:UXML>\n', 'utf8');
    fs.writeFileSync(pkgUssPath, '.pkg-theme-panel {\n  display: flex;\n}\n', 'utf8');

    const uxmlLines = [
      '<ui:UXML>',
      '  <Style src="project://database/Assets/UI/MainHud.uss?fileID=7433441132597879392&amp;guid=abc#MainHud" />',
      '  <ui:Style src="./MainHud.uss" />',
      '  <Template name="CardTpl" src="Templates/ItemCard.uxml" />',
      '  <Style src="Packages/com.unity.ui.theme/Styles/PkgTheme.uss" />',
      '  <ui:Button name="StartBtn" class="primary-btn hud-control" />',
      '</ui:UXML>',
    ];
    const uxmlContent = uxmlLines.join('\n');
    fs.writeFileSync(uxmlPath, uxmlContent, 'utf8');

    // Collect elements across Assets/ and Library/PackageCache/
    const elements = collectUiToolkitElements(root);
    expect(elements.some((e) => e.className === 'pkg-theme-panel')).toBe(true);

    // USS property completions include Flexbox & standard USS properties alongside -unity-*
    const ussProvider = new UnityUssCompletionProvider(() => elements);
    const flexDoc = vscode.__mock.createTextDocument(
      vscode.Uri.file(ussPath),
      '.primary-btn {\n  flex-',
      'uss',
    );
    const flexItems = ussProvider.provideCompletionItems(flexDoc, new vscode.Position(1, 7)) ?? [];
    const expectedProps = [
      'flex-direction',
      'flex-grow',
      'flex-shrink',
      'flex-wrap',
      'flex-basis',
      'align-items',
      'align-self',
      'align-content',
      'justify-content',
      'width',
      'height',
      'min-width',
      'min-height',
      'max-width',
      'max-height',
      'margin',
      'padding',
      'position',
      'left',
      'top',
      'right',
      'bottom',
      'background-color',
      'background-image',
      'border-radius',
      'border-width',
      'border-color',
      'color',
      'font-size',
      'opacity',
      'display',
      'visibility',
      'overflow',
      'translate',
      'scale',
      'rotate',
      'transition-property',
      'transition-duration',
    ];
    for (const propName of expectedProps) {
      const found = flexItems.find((i) => i.label === propName);
      expect(found).toBeDefined();
      expect(found?.kind).toBe(vscode.CompletionItemKind.Property);
      expect(found?.detail).toBe('[UnitySense] Unity UI Toolkit USS 스타일 속성');
    }
    const unitySpecific = flexItems.find((i) => i.label === '-unity-font-definition');
    expect(unitySpecific?.detail).toBe('[UnitySense] Unity USS 전용 스타일 속성');

    // Colon inside rule body does not falsely emit selector pseudo-states
    const valueColonDoc = vscode.__mock.createTextDocument(
      vscode.Uri.file(ussPath),
      '.primary-btn {\n  color:',
      'uss',
    );
    expect(ussProvider.provideCompletionItems(valueColonDoc, new vscode.Position(1, 8))).toBeUndefined();

    // UXML F12 DefinitionProvider for <Style src>, <Template src>, class="", and name=""
    const uxmlDefProvider = new UnityUxmlDefinitionProvider(root, () => elements);
    const uxmlDoc = vscode.__mock.createTextDocument(vscode.Uri.file(uxmlPath), uxmlContent, 'xml');

    // 1. project://database/...?fileID=...#...
    const dbSrcCol = uxmlLines[1].indexOf('MainHud.uss');
    const dbLoc = uxmlDefProvider.provideDefinition(uxmlDoc, new vscode.Position(1, dbSrcCol));
    expect(path.resolve(dbLoc!.uri.fsPath)).toBe(path.resolve(ussPath));
    expect(dbLoc!.range.start.line).toBe(0);

    // 2. Relative ./MainHud.uss on <ui:Style>
    const relSrcCol = uxmlLines[2].indexOf('MainHud.uss');
    const relLoc = uxmlDefProvider.provideDefinition(uxmlDoc, new vscode.Position(2, relSrcCol));
    expect(path.resolve(relLoc!.uri.fsPath)).toBe(path.resolve(ussPath));

    // 3. Relative <Template src="Templates/ItemCard.uxml" />
    const tplSrcCol = uxmlLines[3].indexOf('ItemCard.uxml');
    const tplLoc = uxmlDefProvider.provideDefinition(uxmlDoc, new vscode.Position(3, tplSrcCol));
    expect(path.resolve(tplLoc!.uri.fsPath)).toBe(path.resolve(templatePath));

    // 4. Packages/... resolved through Library/PackageCache
    const pkgSrcCol = uxmlLines[4].indexOf('PkgTheme.uss');
    const pkgLoc = uxmlDefProvider.provideDefinition(uxmlDoc, new vscode.Position(4, pkgSrcCol));
    expect(path.resolve(pkgLoc!.uri.fsPath)).toBe(path.resolve(pkgUssPath));

    // 5. class="primary-btn hud-control" resolves specific token under cursor
    const firstClassCol = uxmlLines[5].indexOf('primary-btn') + 2;
    const firstClassLoc = uxmlDefProvider.provideDefinition(uxmlDoc, new vscode.Position(5, firstClassCol));
    expect(path.resolve(firstClassLoc!.uri.fsPath)).toBe(path.resolve(ussPath));
    expect(firstClassLoc!.range.start.line).toBe(0);

    const secondClassCol = uxmlLines[5].indexOf('hud-control') + 3;
    const secondClassLoc = uxmlDefProvider.provideDefinition(uxmlDoc, new vscode.Position(5, secondClassCol));
    expect(path.resolve(secondClassLoc!.uri.fsPath)).toBe(path.resolve(ussPath));
    expect(secondClassLoc!.range.start.line).toBe(4);

    // 6. name="StartBtn" resolves #StartBtn in USS
    const nameCol = uxmlLines[5].indexOf('StartBtn') + 1;
    const nameLoc = uxmlDefProvider.provideDefinition(uxmlDoc, new vscode.Position(5, nameCol));
    expect(path.resolve(nameLoc!.uri.fsPath)).toBe(path.resolve(ussPath));
    expect(nameLoc!.range.start.line).toBe(8);

    // 7. Non-UXML file returns undefined
    expect(uxmlDefProvider.provideDefinition(flexDoc, new vscode.Position(0, 2))).toBeUndefined();
  });

  it('reads EditorInstance.json, resolves Editor.log path, and generates .vscode/launch.json preserving user configs', () => {
    const root = createTempProject();
    fs.writeFileSync(
      path.join(root, 'Library', 'EditorInstance.json'),
      JSON.stringify({ process_id: 42420, version: '6000.0.23f1' }),
      'utf8',
    );
    fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.vscode', 'launch.json'),
      JSON.stringify({
        version: '0.2.0',
        configurations: [{ name: 'Custom Node Config', type: 'node', request: 'launch' }],
      }),
      'utf8',
    );

    const info = readEditorInstance(root);
    expect(info?.process_id).toBe(42420);
    expect(info?.version).toBe('6000.0.23f1');

    const result = generateUnityLaunchConfig(root);
    expect(result.editorInfo?.process_id).toBe(42420);
    const written = JSON.parse(fs.readFileSync(result.filePath, 'utf8')) as {
      configurations: Array<{ name: string; type: string; request?: string; processId?: string }>;
    };
    expect(written.configurations.some((c) => c.name === 'Custom Node Config')).toBe(true);
    const unityCfg = written.configurations.find((c) => c.type === 'vstuc');
    expect(unityCfg?.request).toBe('attach');
    expect(unityCfg?.processId).toBeUndefined();

    const winLog = resolveUnityEditorLogPath(root, 'win32', { LOCALAPPDATA: 'C:\\Users\\Demo\\AppData\\Local' });
    expect(winLog.toLowerCase()).toContain('unity');
    expect(winLog.toLowerCase()).toContain('editor.log');
  });

  it('sends Unity VisualStudioIntegration UDP ShowUsage packet for live Editor PID', async () => {
    const root = createTempProject();
    const pid = process.pid;
    const expectedPort = 56002 + (pid % 1000);
    fs.writeFileSync(
      path.join(root, 'Library', 'EditorInstance.json'),
      JSON.stringify({ process_id: pid, version: '6000.5.10f1' }),
      'utf8',
    );

    const captured: Array<{ port: number; pingType: number; usageType: number; payload: string }> = [];
    const ok = await openAssetInUnityEditor(
      root,
      'Assets/Scenes/Stage01.unity',
      'Canvas/Hero',
      async (port, pingPacket, showUsagePacket) => {
        const len = showUsagePacket.readInt32LE(4);
        captured.push({
          port,
          pingType: pingPacket.readInt32LE(0),
          usageType: showUsagePacket.readInt32LE(0),
          payload: showUsagePacket.subarray(8, 8 + len).toString('utf8'),
        });
        return true;
      },
    );

    expect(ok).toBe(true);
    expect(captured.length).toBe(1);
    expect(captured[0].port).toBe(expectedPort);
    expect(captured[0].pingType).toBe(1);
    expect(captured[0].usageType).toBe(25);
    expect(JSON.parse(captured[0].payload)).toEqual({
      Path: 'Assets/Scenes/Stage01.unity',
      GameObjectPath: ['Canvas', 'Hero'],
    });
  });

  it('handles UTF-8 BOM and preserves top-level launch.json properties such as compounds and inputs', () => {
    const root = createTempProject();
    fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
    const launchPath = path.join(root, '.vscode', 'launch.json');
    const withBom =
      '\uFEFF' +
      [
        '{',
        '  // User launch configuration with BOM',
        '  "version": "0.2.0",',
        '  "configurations": [',
        '    { "name": "Existing", "type": "node", "request": "launch", },',
        '  ],',
        '  "compounds": [{ "name": "All", "configurations": ["Existing"] }],',
        '  "inputs": [{ "id": "arg1", "type": "promptString", "description": "Arg" }],',
        '}',
      ].join('\n');
    fs.writeFileSync(launchPath, withBom, 'utf8');

    const res = generateUnityLaunchConfig(root);
    expect(res.aborted).toBeUndefined();
    const updated = JSON.parse(fs.readFileSync(launchPath, 'utf8')) as {
      version: string;
      configurations: Array<{ name: string; type: string }>;
      compounds?: Array<{ name: string; configurations: string[] }>;
      inputs?: Array<{ id: string }>;
    };
    expect(updated.compounds).toEqual([{ name: 'All', configurations: ['Existing'] }]);
    expect(updated.inputs).toEqual([{ id: 'arg1', type: 'promptString', description: 'Arg' }]);
    expect(updated.configurations.some((c) => c.name === 'Existing')).toBe(true);
    expect(updated.configurations.some((c) => c.type === 'vstuc')).toBe(true);
  });

  it('highlights asmdef self-reference inside references array rather than name property', () => {
    const root = createTempProject();
    const selfAsm = path.join(root, 'Assets', 'Scripts', 'Core', 'Game.Core.asmdef');
    const content = JSON.stringify(
      {
        name: 'Game.Core',
        references: ['Game.Core'],
      },
      null,
      2,
    );
    fs.writeFileSync(selfAsm, content, 'utf8');

    const provider = new UnityAsmdefProvider(root);
    const doc = vscode.__mock.createTextDocument(vscode.Uri.file(selfAsm), content, 'json');
    const diags = provider.validateDocument(doc);
    expect(diags.length).toBe(1);
    expect(diags[0].message).toContain('순환 어셈블리 참조');
    expect(doc.getText(diags[0].range)).toBe('Game.Core');
    const refsLine = content.split('\n').findIndex((l) => l.includes('"references"'));
    expect(diags[0].range.start.line).toBeGreaterThan(refsLine);
  });
});
