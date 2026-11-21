import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it } from 'vitest';
import { UnityCSharpCodeActionProvider } from '../../src/analyzers/csharpCodeActionProvider.ts';

const TEMP_DIR = path.join(process.cwd(), 'test-output', 'codeaction-provider-test');

describe('UnityCSharpCodeActionProvider', () => {
  afterEach(() => {
    vscode.__mock.reset();
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('provides QuickFixes for UB1002 Awake caching, UB1003 hash extraction, and FormerlySerializedAs refactoring', async () => {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const csPath = path.join(TEMP_DIR, 'QuickFixSample.cs');
    const source = [
      'using UnityEngine;',
      '',
      'public class QuickFixSample : MonoBehaviour',
      '{',
      '    [SerializeField]',
      '    private float moveSpeed = 5f;',
      '    private Material _mat;',
      '    void Update()',
      '    {',
      '        var rb = GetComponent<Rigidbody>();',
      '        _mat.SetColor("_BaseColor", Color.red);',
      '    }',
      '}',
    ].join('\n');
    fs.writeFileSync(csPath, source, 'utf8');

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(csPath));
    const provider = new UnityCSharpCodeActionProvider();

    // 1. UB1002 GetComponent<Rigidbody>() caching inside Update()
    const gcLine = 9;
    const gcActions = provider.provideCodeActions(doc, new vscode.Range(gcLine, 17, gcLine, 17));
    const cacheFix = gcActions.find((a) => a.title.includes("Awake()에 'Rigidbody' 컴포넌트 캐싱"));
    expect(cacheFix).toBeDefined();
    expect(cacheFix?.edit).toBeDefined();
    await vscode.workspace.applyEdit(cacheFix!.edit!);
    const afterCache = fs.readFileSync(csPath, 'utf8');
    expect(afterCache).toContain('private Rigidbody _cachedRigidbody;');
    expect(afterCache).toContain('private void Awake()');
    expect(afterCache).toContain('var rb = _cachedRigidbody;');

    // Reset source for UB1003 & UB4001 tests
    fs.writeFileSync(csPath, source, 'utf8');
    const doc2 = vscode.__mock.createTextDocument(vscode.Uri.file(csPath), source, 'csharp');

    // 2. UB1003 Shader property hash extraction
    const shaderLine = 10;
    const hashActions = provider.provideCodeActions(doc2, new vscode.Range(shaderLine, 25, shaderLine, 25));
    const hashFix = hashActions.find((a) => a.title.includes('static readonly int'));
    expect(hashFix).toBeDefined();
    await vscode.workspace.applyEdit(hashFix!.edit!);
    const afterHash = fs.readFileSync(csPath, 'utf8');
    expect(afterHash).toContain('private static readonly int BaseColorId = Shader.PropertyToID("_BaseColor");');
    expect(afterHash).toContain('_mat.SetColor(BaseColorId, Color.red);');

    // 3. UB4001 [FormerlySerializedAs] on moveSpeed
    fs.writeFileSync(csPath, source, 'utf8');
    const doc3 = vscode.__mock.createTextDocument(vscode.Uri.file(csPath), source, 'csharp');
    const fsaActions = provider.provideCodeActions(doc3, new vscode.Range(5, 18, 5, 18));
    const fsaFix = fsaActions.find((a) => a.title.includes('FormerlySerializedAs("moveSpeed")'));
    expect(fsaFix).toBeDefined();
    await vscode.workspace.applyEdit(fsaFix!.edit!);
    const afterFsa = fs.readFileSync(csPath, 'utf8');
    expect(afterFsa).toContain('[UnityEngine.Serialization.FormerlySerializedAs("moveSpeed")]');
  });

  it('ignores commented-out shader/animator calls and isolates Awake injection to the enclosing class', async () => {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const csPath = path.join(TEMP_DIR, 'TwoClasses.cs');
    const source = [
      'using UnityEngine;',
      '',
      'public class FirstActor : MonoBehaviour',
      '{',
      '    private Material _mat;',
      '    private Animator _anim;',
      '    void Update()',
      '    {',
      '        // _mat.SetFloat("_CommentedShader", 1f);',
      '        // _anim.SetBool("CommentedAnim", true);',
      '        // Shader.PropertyToID("_CommentedDirect");',
      '        _mat.SetFloat("_RealProp", 1f); // inline comment',
      '        var rb = GetComponent<Rigidbody>();',
      '    }',
      '}',
      '',
      'public class SecondActor : MonoBehaviour',
      '{',
      '    private void Awake()',
      '    {',
      '    }',
      '}',
    ].join('\n');
    fs.writeFileSync(csPath, source, 'utf8');

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(csPath));
    const provider = new UnityCSharpCodeActionProvider();

    // Commented lines must NOT offer hash extraction quick fix
    for (const commentedLine of [8, 9, 10]) {
      const actions = provider.provideCodeActions(doc, new vscode.Range(commentedLine, 12, commentedLine, 12));
      expect(actions.some((a) => a.title.includes('static readonly int'))).toBe(false);
    }

    // Active code before inline comment MUST offer hash extraction with accurate range
    const activeHashActions = provider.provideCodeActions(doc, new vscode.Range(11, 20, 11, 20));
    const realHashFix = activeHashActions.find((a) => a.title.includes('static readonly int'));
    expect(realHashFix).toBeDefined();
    await vscode.workspace.applyEdit(realHashFix!.edit!);
    const afterHash = fs.readFileSync(csPath, 'utf8');
    expect(afterHash).toContain('private static readonly int RealPropId = Shader.PropertyToID("_RealProp");');
    expect(afterHash).toContain('_mat.SetFloat(RealPropId, 1f); // inline comment');

    // Reset file and verify GetComponent caching in FirstActor does NOT inject into SecondActor.Awake()
    fs.writeFileSync(csPath, source, 'utf8');
    const doc2 = vscode.__mock.createTextDocument(vscode.Uri.file(csPath), source, 'csharp');
    const gcActions = provider.provideCodeActions(doc2, new vscode.Range(12, 20, 12, 20));
    const cacheFix = gcActions.find((a) => a.title.includes("Awake()에 'Rigidbody'"));
    expect(cacheFix).toBeDefined();
    await vscode.workspace.applyEdit(cacheFix!.edit!);
    const afterCache = fs.readFileSync(csPath, 'utf8');

    const secondActorStart = afterCache.indexOf('public class SecondActor');
    const firstActorPart = afterCache.slice(0, secondActorStart);
    const secondActorPart = afterCache.slice(secondActorStart);
    expect(firstActorPart).toContain('private void Awake()');
    expect(firstActorPart).toContain('_cachedRigidbody = GetComponent<Rigidbody>();');
    expect(secondActorPart).not.toContain('_cachedRigidbody');
  });
});
