import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'vitest';
import * as vscode from 'vscode';
import {
  buildRiderCSharpSemanticRules,
  buildRiderTextMateRules,
  RIDER_STRUCT_DISTINCT_COLOR,
  RiderHighlightingManager,
  registerToggleRiderHighlightingCommand,
  type TextMateRule,
} from '../../src/theme/riderHighlightingManager.ts';

function createMockMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T {
      return (store.has(key) ? store.get(key) : defaultValue) as T;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
  };
}

describe('RiderHighlightingManager', () => {
  beforeEach(() => {
    vscode.__mock.reset();
  });

  it('does not touch user settings when disabled by default', async () => {
    const manager = new RiderHighlightingManager();
    await manager.initialize();

    assert.equal(vscode.__mock.configStore.has('editor.semanticTokenColorCustomizations'), false);
    assert.equal(vscode.__mock.configStore.has('editor.tokenColorCustomizations'), false);
    assert.equal(vscode.__mock.configStore.has('[csharp].editor.bracketPairColorization.enabled'), false);
    manager.dispose();
  });

  it('unifies struct and class to Rider Dark #C191FF, disables C# rainbow brackets, preserves workbench colors, and cleanly restores on disable', async () => {
    vscode.__mock.configStore.set('editor.semanticTokenColorCustomizations', {
      rules: {
        'function:typescript': '#FF0000',
        'keyword:csharp': '#112233',
      },
    });
    const customRule: TextMateRule = {
      name: 'User Custom Rule',
      scope: 'custom.scope',
      settings: { foreground: '#ABCDEF' },
    };
    vscode.__mock.configStore.set('editor.tokenColorCustomizations', {
      textMateRules: [customRule],
    });
    vscode.__mock.configStore.set('[csharp].editor.bracketPairColorization.enabled', true);

    const memento = createMockMemento();
    const ctx = { globalState: memento } as unknown as vscode.ExtensionContext;
    const manager = new RiderHighlightingManager(ctx);
    await manager.initialize();

    const enabled = await manager.toggle();
    assert.equal(enabled, true);

    // Workbench background/UI must NEVER be touched
    assert.equal(vscode.__mock.configStore.has('workbench.colorCustomizations'), false);

    // C# language-scoped bracket pair colorization must be disabled so {} and () use #BDBDBD instead of #179FFF
    assert.equal(vscode.__mock.configStore.get('[csharp].editor.bracketPairColorization.enabled'), false);
    assert.equal(vscode.__mock.configStore.get('[csharp].editor.semanticHighlighting.enabled'), true);

    const appliedSemantic = vscode.__mock.configStore.get('editor.semanticTokenColorCustomizations') as {
      enabled?: boolean;
      rules?: Record<string, unknown>;
    };
    assert.equal(appliedSemantic.enabled, true);
    assert.equal(appliedSemantic.rules?.['function:typescript'], '#FF0000');
    assert.equal(appliedSemantic.rules?.['keyword:csharp'], '#6C95EB');
    assert.equal(appliedSemantic.rules?.['controlKeyword:csharp'], '#6C95EB');
    assert.equal(appliedSemantic.rules?.['keywordControl:csharp'], '#6C95EB');
    assert.equal(appliedSemantic.rules?.['modifier:csharp'], '#6C95EB');
    assert.equal(appliedSemantic.rules?.['namespace:csharp'], '#C191FF');
    assert.equal(appliedSemantic.rules?.['type:csharp'], '#C191FF');
    assert.equal(appliedSemantic.rules?.['class:csharp'], '#C191FF');
    assert.equal(appliedSemantic.rules?.['struct:csharp'], '#C191FF');
    assert.equal(appliedSemantic.rules?.['interface:csharp'], '#E1BFFF');
    assert.equal(appliedSemantic.rules?.['field:csharp'], '#65C3CC');
    assert.equal(appliedSemantic.rules?.['method:csharp'], '#3ACC9B');
    assert.equal(appliedSemantic.rules?.['punctuation:csharp'], '#BDBDBD');

    const appliedTokens = vscode.__mock.configStore.get('editor.tokenColorCustomizations') as {
      textMateRules?: TextMateRule[];
    };
    assert.ok(Array.isArray(appliedTokens.textMateRules));
    assert.equal(appliedTokens.textMateRules[0]?.name, 'User Custom Rule');
    assert.ok(appliedTokens.textMateRules.length >= 13);

    // Toggle distinguishStructs on -> uses Rider lavender (#E1BFFF), never Dark+ green (#86C691)
    vscode.__mock.configStore.set('unitySense.csharp.riderHighlighting.distinguishStructs', true);
    await manager.syncFromConfig();
    const distinguished = vscode.__mock.configStore.get('editor.semanticTokenColorCustomizations') as {
      rules?: Record<string, unknown>;
    };
    assert.equal(distinguished.rules?.['struct:csharp'], RIDER_STRUCT_DISTINCT_COLOR);
    assert.equal(distinguished.rules?.['recordStruct:csharp'], RIDER_STRUCT_DISTINCT_COLOR);
    assert.notEqual(RIDER_STRUCT_DISTINCT_COLOR, '#86C691');

    // Disable and verify full rollback of semantic, textMate, and [csharp] bracket settings
    const disabled = await manager.toggle();
    assert.equal(disabled, false);

    const restoredSemantic = vscode.__mock.configStore.get('editor.semanticTokenColorCustomizations') as {
      enabled?: boolean;
      rules?: Record<string, unknown>;
    };
    assert.equal(restoredSemantic.enabled, undefined);
    assert.equal(restoredSemantic.rules?.['function:typescript'], '#FF0000');
    assert.equal(restoredSemantic.rules?.['keyword:csharp'], '#112233');
    assert.equal(restoredSemantic.rules?.['struct:csharp'], undefined);
    assert.equal(restoredSemantic.rules?.['namespace:csharp'], undefined);

    const restoredTokens = vscode.__mock.configStore.get('editor.tokenColorCustomizations') as {
      textMateRules?: TextMateRule[];
    };
    assert.deepEqual(restoredTokens.textMateRules, [customRule]);
    assert.equal(vscode.__mock.configStore.get('[csharp].editor.bracketPairColorization.enabled'), true);
    assert.equal(vscode.__mock.configStore.has('[csharp].editor.semanticHighlighting.enabled'), false);

    manager.dispose();
  });

  it('migrates stale v1.1.0 distinguishStructs=true global setting on first v1.1.3 startup', async () => {
    vscode.__mock.configStore.set('unitySense.csharp.riderHighlighting.enabled', true);
    vscode.__mock.configStore.set('unitySense.csharp.riderHighlighting.distinguishStructs', true);

    const memento = createMockMemento();
    const ctx = { globalState: memento } as unknown as vscode.ExtensionContext;
    const manager = new RiderHighlightingManager(ctx);
    await manager.initialize();

    assert.equal(
      vscode.__mock.configStore.has('unitySense.csharp.riderHighlighting.distinguishStructs'),
      false,
    );
    const appliedSemantic = vscode.__mock.configStore.get('editor.semanticTokenColorCustomizations') as {
      rules?: Record<string, unknown>;
    };
    assert.equal(appliedSemantic.rules?.['struct:csharp'], '#C191FF');
    manager.dispose();
  });

  it('removes semantic, token, and [csharp] customizations completely when no prior rules existed', async () => {
    const manager = new RiderHighlightingManager();
    const cmd = registerToggleRiderHighlightingCommand(manager);
    await manager.initialize();

    await vscode.commands.executeCommand('unitySense.toggleRiderHighlighting');
    assert.equal(vscode.__mock.configStore.has('editor.semanticTokenColorCustomizations'), true);
    assert.equal(vscode.__mock.configStore.has('editor.tokenColorCustomizations'), true);
    assert.equal(vscode.__mock.configStore.get('[csharp].editor.bracketPairColorization.enabled'), false);

    await vscode.commands.executeCommand('unitySense.toggleRiderHighlighting');
    assert.equal(vscode.__mock.configStore.has('editor.semanticTokenColorCustomizations'), false);
    assert.equal(vscode.__mock.configStore.has('editor.tokenColorCustomizations'), false);
    assert.equal(vscode.__mock.configStore.has('[csharp].editor.bracketPairColorization.enabled'), false);
    assert.equal(vscode.__mock.configStore.has('[csharp].editor.semanticHighlighting.enabled'), false);

    cmd.dispose();
    manager.dispose();
  });

  it('scopes all semantic rules to :csharp and orders C# operator-expression keywords after punctuation/arrows', () => {
    const rules = buildRiderCSharpSemanticRules(false);
    for (const key of Object.keys(rules)) {
      assert.equal(key.endsWith(':csharp'), true, `Expected :csharp suffix on ${key}`);
    }
    const tmRules = buildRiderTextMateRules(false);
    const arrowIdx = tmRules.findIndex(
      (r) => Array.isArray(r.scope) && r.scope.includes('keyword.operator.arrow.cs'),
    );
    const newExprIdx = tmRules.findIndex(
      (r) => Array.isArray(r.scope) && r.scope.includes('keyword.operator.expression.new.cs'),
    );
    const keywordIdx = tmRules.findIndex(
      (r) => Array.isArray(r.scope) && r.scope.includes('keyword.type.cs'),
    );
    assert.ok(keywordIdx >= 0 && arrowIdx > keywordIdx && newExprIdx > arrowIdx);
  });
});
