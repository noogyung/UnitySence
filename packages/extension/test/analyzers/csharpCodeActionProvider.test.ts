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

  it('provides QuickFix for Camera.main in Update() and ignores commented-out Camera.main / GetComponent', async () => {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const csPath = path.join(TEMP_DIR, 'CameraMainQuickFix.cs');
    const source = [
      'using UnityEngine;',
      '',
      'public class CameraController : MonoBehaviour',
      '{',
      '    private void Update()',
      '    {',
      '        Camera.main.backgroundColor = Color.Lerp(Color.red, Color.blue, Mathf.PingPong(Time.time, 1));',
      '        // Camera.main.backgroundColor = Color.black;',
      '        // var rb = GetComponent<Rigidbody>();',
      '    }',
      '}',
    ].join('\n');
    fs.writeFileSync(csPath, source, 'utf8');

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(csPath));
    const provider = new UnityCSharpCodeActionProvider();

    // Active Camera.main line offers QuickFix
    const camActions = provider.provideCodeActions(doc, new vscode.Range(6, 12, 6, 12));
    const camFix = camActions.find((a) => a.title === "[UnitySense] Awake()에 'Camera.main' 캐싱 (_cachedMainCamera)");
    expect(camFix).toBeDefined();
    expect(camFix?.kind).toBe(vscode.CodeActionKind.QuickFix);
    expect(camFix?.isPreferred).toBe(true);
    await vscode.workspace.applyEdit(camFix!.edit!);

    const afterFix = fs.readFileSync(csPath, 'utf8');
    expect(afterFix).toContain('private Camera _cachedMainCamera;');
    expect(afterFix).toContain('private void Awake()');
    expect(afterFix).toContain('_cachedMainCamera = Camera.main;');
    expect(afterFix).toContain(
      '_cachedMainCamera.backgroundColor = Color.Lerp(Color.red, Color.blue, Mathf.PingPong(Time.time, 1));',
    );
    expect(afterFix).not.toContain('        Camera.main.backgroundColor');

    // Commented-out Camera.main and GetComponent<T>() must NOT offer caching QuickFix
    const commentedCamActions = provider.provideCodeActions(doc, new vscode.Range(7, 15, 7, 15));
    expect(commentedCamActions.some((a) => a.title.includes('Camera.main'))).toBe(false);

    const commentedGcActions = provider.provideCodeActions(doc, new vscode.Range(8, 20, 8, 20));
    expect(commentedGcActions.some((a) => a.title.includes('컴포넌트 캐싱'))).toBe(false);
  });

  it('appends Camera.main to existing Awake(), avoids duplicates, and triggers via UB1001 diagnostic in helpers', async () => {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const csPath = path.join(TEMP_DIR, 'CameraMainExistingAwake.cs');
    const sourceWithAwake = [
      'using UnityEngine;',
      '',
      'public class HudCamera : MonoBehaviour',
      '{',
      '    private int _ready;',
      '    private void Awake()',
      '    {',
      '        _ready = 1;',
      '    }',
      '',
      '    private void SyncCamera()',
      '    {',
      '        Camera.main.backgroundColor = Color.Lerp(Color.red, Color.blue, Mathf.PingPong(Time.time, 1));',
      '    }',
      '}',
    ].join('\n');
    fs.writeFileSync(csPath, sourceWithAwake, 'utf8');

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(csPath));
    const provider = new UnityCSharpCodeActionProvider();

    // Without UB1001 diagnostic, non-critical helper SyncCamera() does not trigger Camera.main QuickFix
    const noDiagActions = provider.provideCodeActions(doc, new vscode.Range(12, 10, 12, 10));
    expect(noDiagActions.some((a) => a.title.includes('Camera.main'))).toBe(false);

    // With UB1001 diagnostic context, SyncCamera() DOES trigger Camera.main QuickFix
    const diagContext = {
      diagnostics: [
        {
          range: new vscode.Range(12, 8, 12, 19),
          code: { value: 'UB1001' },
        },
      ],
    } as unknown as vscode.CodeActionContext;
    const withDiagActions = provider.provideCodeActions(doc, new vscode.Range(12, 10, 12, 10), diagContext);
    const camFix = withDiagActions.find((a) => a.title.includes('Camera.main'));
    expect(camFix).toBeDefined();
    await vscode.workspace.applyEdit(camFix!.edit!);

    const afterAppend = fs.readFileSync(csPath, 'utf8');
    expect(afterAppend).toContain('private Camera _cachedMainCamera;');
    expect(afterAppend).toContain('_cachedMainCamera = Camera.main;');
    expect(afterAppend).toContain('_ready = 1;');
    expect(afterAppend.split('Awake()').length - 1).toBe(1);
    expect(afterAppend).toContain('_cachedMainCamera.backgroundColor =');

    // If _cachedMainCamera and Awake assignment already exist, do NOT duplicate field or assignment
    const alreadyCachedSource = [
      'using UnityEngine;',
      '',
      'public class HudCamera : MonoBehaviour',
      '{',
      '    private Camera _cachedMainCamera;',
      '    private void Awake()',
      '    {',
      '        _cachedMainCamera = Camera.main;',
      '    }',
      '',
      '    private void Update()',
      '    {',
      '        Camera.main.backgroundColor = Color.white;',
      '    }',
      '}',
    ].join('\n');
    fs.writeFileSync(csPath, alreadyCachedSource, 'utf8');
    const doc2 = vscode.__mock.createTextDocument(vscode.Uri.file(csPath), alreadyCachedSource, 'csharp');
    const secondActions = provider.provideCodeActions(doc2, new vscode.Range(12, 10, 12, 10));
    const secondFix = secondActions.find((a) => a.title.includes('Camera.main'));
    expect(secondFix).toBeDefined();
    await vscode.workspace.applyEdit(secondFix!.edit!);

    const afterSecond = fs.readFileSync(csPath, 'utf8');
    expect(afterSecond.split('private Camera _cachedMainCamera;').length - 1).toBe(1);
    expect(afterSecond.split('_cachedMainCamera = Camera.main;').length - 1).toBe(1);
    expect(afterSecond).toContain('_cachedMainCamera.backgroundColor = Color.white;');
  });

  it('handles Awake comment/string braces, expression-bodied Awake, and ignores commented/string field names', async () => {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const provider = new UnityCSharpCodeActionProvider();

    // 1. Commented brace on Awake() header + string "}" inside Awake() + commented field name
    const csPath1 = path.join(TEMP_DIR, 'AwakeCommentAndStringBraces.cs');
    const source1 = [
      'using UnityEngine;',
      '',
      'public class AwakeTrap : MonoBehaviour',
      '{',
      '    // private Camera _cachedMainCamera;',
      '    private string _note = "_cachedMainCamera";',
      '    private void Awake() // { setup }',
      '    {',
      '        var s = "}";',
      '    }',
      '    private void Update()',
      '    {',
      '        Camera.main.enabled = false;',
      '    }',
      '}',
    ].join('\n');
    fs.writeFileSync(csPath1, source1, 'utf8');
    const doc1 = await vscode.workspace.openTextDocument(vscode.Uri.file(csPath1));
    const actions1 = provider.provideCodeActions(doc1, new vscode.Range(12, 10, 12, 10));
    const fix1 = actions1.find((a) => a.title.includes('Camera.main'));
    expect(fix1).toBeDefined();
    await vscode.workspace.applyEdit(fix1!.edit!);
    const after1 = fs.readFileSync(csPath1, 'utf8');
    expect(after1).toContain('\n    private Camera _cachedMainCamera;\n');
    expect(after1.split('Awake()').length - 1).toBe(1);
    expect(after1).toContain('_cachedMainCamera = Camera.main;');
    expect(after1).toContain('_cachedMainCamera.enabled = false;');

    // 2. Expression-bodied Awake() => Init(); converts cleanly to block body
    const csPath2 = path.join(TEMP_DIR, 'ExpressionAwake.cs');
    const source2 = [
      'using UnityEngine;',
      '',
      'public class ExprAwakeActor : MonoBehaviour',
      '{',
      '    private bool _ready;',
      '    private void Awake() => _ready = true;',
      '    private void Update()',
      '    {',
      '        Camera.main.enabled = _ready;',
      '    }',
      '}',
    ].join('\n');
    fs.writeFileSync(csPath2, source2, 'utf8');
    const doc2 = vscode.__mock.createTextDocument(vscode.Uri.file(csPath2), source2, 'csharp');
    const actions2 = provider.provideCodeActions(doc2, new vscode.Range(8, 10, 8, 10));
    const fix2 = actions2.find((a) => a.title.includes('Camera.main'));
    expect(fix2).toBeDefined();
    await vscode.workspace.applyEdit(fix2!.edit!);
    const after2 = fs.readFileSync(csPath2, 'utf8');
    expect(after2).toContain('private Camera _cachedMainCamera;');
    expect(after2).toContain('private void Awake() {');
    expect(after2).toContain('_cachedMainCamera = Camera.main;');
    expect(after2).toContain('_ready = true;');
    expect(after2).toContain('_cachedMainCamera.enabled = _ready;');
    expect(after2).not.toContain('=> _ready = true;');
  });

  it('skips Camera.main inside Awake(), replaces multiple Camera.main on one line, and handles string/comment prefixes', async () => {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const provider = new UnityCSharpCodeActionProvider();
    const csPath = path.join(TEMP_DIR, 'CameraMainEdgeCases.cs');
    const source = [
      'using UnityEngine;',
      '',
      'public class CameraEdgeActor : MonoBehaviour',
      '{',
      '    private void Awake()',
      '    {',
      '        Camera.main.enabled = true;',
      '    }',
      '    private void Update()',
      '    {',
      '        var d = Vector3.Distance(Camera.main.transform.position, Camera.main.ScreenToWorldPoint(Vector3.zero));',
      '        Debug.Log("http://x"); Camera.main.enabled = false;',
      '        /* Camera.main.enabled = false; */',
      '        Debug.Log("Camera.main");',
      '    }',
      '}',
    ].join('\n');
    fs.writeFileSync(csPath, source, 'utf8');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(csPath));

    // Line 6 (inside Awake) must NOT offer Camera.main caching even with UB1001 diagnostic
    const awakeDiagCtx = {
      diagnostics: [{ range: new vscode.Range(6, 8, 6, 19), code: 'UB1001' }],
    } as unknown as vscode.CodeActionContext;
    const awakeActions = provider.provideCodeActions(doc, new vscode.Range(6, 10, 6, 10), awakeDiagCtx);
    expect(awakeActions.some((a) => a.title.includes('Camera.main'))).toBe(false);

    // Line 12 (block comment) & Line 13 (string literal) must NOT offer Camera.main caching
    expect(
      provider.provideCodeActions(doc, new vscode.Range(12, 14, 12, 14)).some((a) => a.title.includes('Camera.main')),
    ).toBe(false);
    expect(
      provider.provideCodeActions(doc, new vscode.Range(13, 20, 13, 20)).some((a) => a.title.includes('Camera.main')),
    ).toBe(false);

    // Line 10 has two Camera.main occurrences -> both replaced
    const multiActions = provider.provideCodeActions(doc, new vscode.Range(10, 35, 10, 35));
    const multiFix = multiActions.find((a) => a.title.includes('Camera.main'));
    expect(multiFix).toBeDefined();
    await vscode.workspace.applyEdit(multiFix!.edit!);
    const afterMulti = fs.readFileSync(csPath, 'utf8');
    expect(afterMulti).toContain(
      'var d = Vector3.Distance(_cachedMainCamera.transform.position, _cachedMainCamera.ScreenToWorldPoint(Vector3.zero));',
    );

    // Line 11: string with // before Camera.main still triggers cleanly
    fs.writeFileSync(csPath, source, 'utf8');
    const doc2 = vscode.__mock.createTextDocument(vscode.Uri.file(csPath), source, 'csharp');
    const inlineStrActions = provider.provideCodeActions(doc2, new vscode.Range(11, 34, 11, 34));
    const inlineStrFix = inlineStrActions.find((a) => a.title.includes('Camera.main'));
    expect(inlineStrFix).toBeDefined();
    await vscode.workspace.applyEdit(inlineStrFix!.edit!);
    const afterInlineStr = fs.readFileSync(csPath, 'utf8');
    expect(afterInlineStr).toContain('Debug.Log("http://x"); _cachedMainCamera.enabled = false;');
  });

  it('supports this.gameObject / this.transform GetComponent, digit-prefixed hash IDs, and multiline static readonly guards', async () => {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const provider = new UnityCSharpCodeActionProvider();
    const csPath = path.join(TEMP_DIR, 'ComponentAndHashEdgeCases.cs');
    const source = [
      'using UnityEngine;',
      '',
      'public class EdgeCasesActor : MonoBehaviour',
      '{',
      '    private static readonly int ColorId =',
      '        Shader.PropertyToID("_Color");',
      '    private Material _mat;',
      '    private void Update()',
      '    {',
      '        var rb = this.gameObject.GetComponent<Rigidbody>();',
      '        var col = this.transform.GetComponent<Collider>();',
      '        var otherRb = other.GetComponent<Rigidbody>();',
      '        var otherGoRb = other.gameObject.GetComponent<Rigidbody>();',
      '        Debug.Log("http://x"); _mat.SetFloat("_2DArray", 1f);',
      '        /* _mat.SetFloat("_Commented", 1f); */',
      '        Debug.Log("_mat.SetFloat(\\"_InString\\", 1f);");',
      '    }',
      '}',
    ].join('\n');
    fs.writeFileSync(csPath, source, 'utf8');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(csPath));

    // Line 5: multiline static readonly initializer must NOT be re-extracted
    const multilineHashActions = provider.provideCodeActions(doc, new vscode.Range(5, 12, 5, 12));
    expect(multilineHashActions.some((a) => a.title.includes('static readonly int'))).toBe(false);

    // Line 11 & 12: external receivers must NOT trigger GetComponent caching
    expect(
      provider.provideCodeActions(doc, new vscode.Range(11, 25, 11, 25)).some((a) => a.title.includes('컴포넌트 캐싱')),
    ).toBe(false);
    expect(
      provider.provideCodeActions(doc, new vscode.Range(12, 30, 12, 30)).some((a) => a.title.includes('컴포넌트 캐싱')),
    ).toBe(false);

    // Line 14 & 15: block comment and string literal must NOT trigger hash extraction
    expect(
      provider.provideCodeActions(doc, new vscode.Range(14, 15, 14, 15)).some((a) => a.title.includes('static readonly int')),
    ).toBe(false);
    expect(
      provider.provideCodeActions(doc, new vscode.Range(15, 20, 15, 20)).some((a) => a.title.includes('static readonly int')),
    ).toBe(false);

    // Line 9: this.gameObject.GetComponent<Rigidbody>()
    const gc1Fix = provider
      .provideCodeActions(doc, new vscode.Range(9, 25, 9, 25))
      .find((a) => a.title.includes("Awake()에 'Rigidbody'"));
    expect(gc1Fix).toBeDefined();
    await vscode.workspace.applyEdit(gc1Fix!.edit!);
    const afterGc1 = fs.readFileSync(csPath, 'utf8');
    expect(afterGc1).toContain('var rb = _cachedRigidbody;');
    expect(afterGc1).toContain('_cachedRigidbody = GetComponent<Rigidbody>();');

    // Line 10: this.transform.GetComponent<Collider>()
    fs.writeFileSync(csPath, source, 'utf8');
    const doc2 = vscode.__mock.createTextDocument(vscode.Uri.file(csPath), source, 'csharp');
    const gc2Fix = provider
      .provideCodeActions(doc2, new vscode.Range(10, 25, 10, 25))
      .find((a) => a.title.includes("Awake()에 'Collider'"));
    expect(gc2Fix).toBeDefined();
    await vscode.workspace.applyEdit(gc2Fix!.edit!);
    const afterGc2 = fs.readFileSync(csPath, 'utf8');
    expect(afterGc2).toContain('var col = _cachedCollider;');

    // Line 13: Debug.Log("http://x"); _mat.SetFloat("_2DArray", 1f); -> _2DArrayId
    fs.writeFileSync(csPath, source, 'utf8');
    const doc3 = vscode.__mock.createTextDocument(vscode.Uri.file(csPath), source, 'csharp');
    const hashFix = provider
      .provideCodeActions(doc3, new vscode.Range(13, 35, 13, 35))
      .find((a) => a.title.includes('static readonly int _2DArrayId'));
    expect(hashFix).toBeDefined();
    await vscode.workspace.applyEdit(hashFix!.edit!);
    const afterHash = fs.readFileSync(csPath, 'utf8');
    expect(afterHash).toContain('private static readonly int _2DArrayId = Shader.PropertyToID("_2DArray");');
    expect(afterHash).toContain('Debug.Log("http://x"); _mat.SetFloat(_2DArrayId, 1f);');
  });
});
