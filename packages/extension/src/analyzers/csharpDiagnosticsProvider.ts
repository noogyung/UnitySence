import * as vscode from 'vscode';
import type { ProjectSettingsCache } from '../contracts/index.ts';
import { maskCSharpCommentsAndStrings } from '../completion/unityEventGenerator.ts';

const PERF_CRITICAL_METHODS = new Set([
  'Update',
  'FixedUpdate',
  'LateUpdate',
  'OnGUI',
  'OnRenderObject',
  'OnAnimatorIK',
]);

const KNOWN_BLITTABLE_OR_UNMANAGED_TYPES = new Set([
  'bool', 'byte', 'sbyte', 'short', 'ushort', 'int', 'uint', 'long', 'ulong',
  'float', 'double', 'decimal', 'char', 'void', 'var', 'nint', 'nuint',
  'IntPtr', 'UIntPtr', 'Guid', 'DateTime', 'TimeSpan',
  'float2', 'float3', 'float4', 'float2x2', 'float3x3', 'float4x4',
  'double2', 'double3', 'double4', 'int2', 'int3', 'int4', 'uint2', 'uint3', 'uint4',
  'bool2', 'bool3', 'bool4', 'half', 'half2', 'half3', 'half4', 'quaternion', 'math',
  'Vector2', 'Vector3', 'Vector4', 'Vector2Int', 'Vector3Int',
  'Quaternion', 'Matrix4x4', 'Color', 'Color32', 'Rect', 'Bounds', 'Ray', 'Plane',
  'NativeArray', 'NativeList', 'NativeHashMap', 'NativeParallelHashMap', 'NativeMultiHashMap',
  'NativeQueue', 'NativeReference', 'NativeSlice', 'NativeHashSet', 'NativeBitArray',
  'UnsafeList', 'UnsafeHashMap', 'UnsafePtrList', 'UnsafeUtility',
  'FixedString32Bytes', 'FixedString64Bytes', 'FixedString128Bytes',
  'FixedString512Bytes', 'FixedString4096Bytes',
  'Entity', 'BlobAssetReference', 'JobHandle', 'BurstCompile', 'BurstDiscard',
  'ReadOnly', 'WriteOnly', 'NativeDisableParallelForRestriction', 'DeallocateOnJobCompletion',
]);

const KNOWN_MANAGED_REFERENCE_TYPES = new Set([
  'object', 'Object', 'dynamic', 'List', 'Dictionary', 'HashSet', 'Queue', 'Stack',
  'LinkedList', 'SortedDictionary', 'ConcurrentDictionary', 'StringBuilder', 'Regex',
  'GameObject', 'Transform', 'MonoBehaviour', 'Component', 'ScriptableObject',
  'Behaviour', 'Renderer', 'MeshRenderer', 'Material', 'Shader', 'Texture', 'Texture2D',
  'Camera', 'Rigidbody', 'Collider', 'Animator', 'AudioSource', 'Canvas',
  'Action', 'Func', 'Task', 'Exception', 'Delegate', 'Type', 'Thread',
]);

const CSHARP_KEYWORDS = new Set([
  'abstract', 'as', 'base', 'break', 'case', 'catch', 'checked', 'class', 'const',
  'continue', 'default', 'delegate', 'do', 'else', 'enum', 'event', 'explicit', 'extern',
  'false', 'finally', 'fixed', 'for', 'foreach', 'goto', 'if', 'implicit', 'in',
  'interface', 'internal', 'is', 'lock', 'namespace', 'new', 'null', 'operator', 'out',
  'override', 'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return',
  'sealed', 'sizeof', 'stackalloc', 'static', 'struct', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'unchecked', 'unsafe', 'using', 'virtual', 'volatile', 'while',
  'yield', 'async', 'await', 'nameof', 'where', 'get', 'set', 'init', 'value', 'partial',
]);

export type HoverTypeKind = 'class' | 'struct' | 'interface' | 'enum' | 'delegate' | 'unknown';

export type HoverTypeResolver = (
  doc: vscode.TextDocument,
  position: vscode.Position,
  typeName: string,
) => Promise<HoverTypeKind>;

function extractHoverText(hovers: vscode.Hover[] | undefined): string {
  if (!hovers || hovers.length === 0) return '';
  const chunks: string[] = [];
  for (const h of hovers) {
    for (const c of h.contents) {
      if (typeof c === 'string') {
        chunks.push(c);
      } else if (c && typeof c === 'object' && 'value' in c && typeof c.value === 'string') {
        chunks.push(c.value);
      }
    }
  }
  return chunks.join('\n');
}

export function classifyTypeFromHoverText(hoverText: string): HoverTypeKind {
  if (!hoverText) return 'unknown';
  // Match C# LSP hover signatures such as: "class Foo.Bar", "struct Foo.Bar", "interface Foo.IBar", "(local variable) class ..."
  const match = /\b(class|struct|interface|enum|delegate)\s+[A-Za-z_][A-Za-z0-9_.<>]*/.exec(hoverText);
  if (!match) return 'unknown';
  return match[1] as HoverTypeKind;
}

export async function defaultHoverTypeResolver(
  doc: vscode.TextDocument,
  position: vscode.Position,
): Promise<HoverTypeKind> {
  if (typeof vscode.commands?.executeCommand !== 'function') {
    return 'unknown';
  }
  try {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      doc.uri,
      position,
    );
    return classifyTypeFromHoverText(extractHoverText(hovers));
  } catch {
    return 'unknown';
  }
}

interface BraceBlock {
  startLine: number;
  endLine: number;
  headerName: string;
}

function findMatchingBraceEndLine(maskedLines: string[], openLine: number, openCol: number): number {
  let depth = 0;
  for (let l = openLine; l < maskedLines.length; l++) {
    const line = maskedLines[l] ?? '';
    const startCol = l === openLine ? openCol : 0;
    for (let c = startCol; c < line.length; c++) {
      if (line[c] === '{') depth++;
      else if (line[c] === '}') {
        depth--;
        if (depth === 0) return l;
      }
    }
  }
  return maskedLines.length - 1;
}

function findPerfCriticalMethodBlocks(maskedLines: string[]): BraceBlock[] {
  const blocks: BraceBlock[] = [];
  const methodRe = /\b(Update|FixedUpdate|LateUpdate|OnGUI|OnRenderObject|OnAnimatorIK)\s*\(\s*(?:int\s+\w+\s*)?\)/;

  for (let i = 0; i < maskedLines.length; i++) {
    const line = maskedLines[i] ?? '';
    const m = methodRe.exec(line);
    if (!m || !PERF_CRITICAL_METHODS.has(m[1])) continue;
    // Skip method calls like Update();
    if (line.slice(m.index + m[0].length).trimStart().startsWith(';')) continue;

    // Locate opening brace on same or next 2 lines
    let openLine = -1;
    let openCol = -1;
    for (let look = i; look <= Math.min(maskedLines.length - 1, i + 2); look++) {
      const braceIdx = (maskedLines[look] ?? '').indexOf('{', look === i ? m.index + m[0].length : 0);
      if (braceIdx !== -1) {
        openLine = look;
        openCol = braceIdx;
        break;
      }
      if ((maskedLines[look] ?? '').includes(';')) break;
    }

    if (openLine !== -1) {
      const endLine = findMatchingBraceEndLine(maskedLines, openLine, openCol);
      blocks.push({ startLine: openLine, endLine, headerName: m[1] });
      i = endLine;
    }
  }
  return blocks;
}

function findAttributedBlocks(maskedLines: string[], attrPattern: RegExp): BraceBlock[] {
  const blocks: BraceBlock[] = [];
  for (let i = 0; i < maskedLines.length; i++) {
    const line = maskedLines[i] ?? '';
    if (!attrPattern.test(line)) continue;

    let openLine = -1;
    let openCol = -1;
    for (let look = i; look <= Math.min(maskedLines.length - 1, i + 5); look++) {
      const braceIdx = (maskedLines[look] ?? '').indexOf('{');
      if (braceIdx !== -1) {
        openLine = look;
        openCol = braceIdx;
        break;
      }
      if (look > i && (maskedLines[look] ?? '').includes(';')) break;
    }

    if (openLine !== -1) {
      const endLine = findMatchingBraceEndLine(maskedLines, openLine, openCol);
      blocks.push({ startLine: openLine, endLine, headerName: 'BurstCompile' });
      i = endLine;
    }
  }
  return blocks;
}

function makeDiag(
  line: number,
  col: number,
  length: number,
  message: string,
  severity: vscode.DiagnosticSeverity,
  code: string,
): vscode.Diagnostic {
  const diag = new vscode.Diagnostic(
    new vscode.Range(line, col, line, col + Math.max(1, length)),
    message,
    severity,
  );
  diag.code = code;
  diag.source = 'UnitySense';
  return diag;
}

export async function collectUnityCSharpDiagnostics(
  doc: vscode.TextDocument,
  cache: ProjectSettingsCache,
  hoverResolver: HoverTypeResolver = defaultHoverTypeResolver,
): Promise<vscode.Diagnostic[]> {
  if (doc.languageId !== 'csharp') return [];

  const fsPath = doc.uri.fsPath ?? '';
  if (/[\\/](?:Library[\\/])?PackageCache[\\/]/i.test(fsPath)) {
    return [];
  }

  const text = doc.getText();
  const lines = text.split(/\r?\n/);
  const maskedText = maskCSharpCommentsAndStrings(text);
  const maskedLines = maskedText.split(/\r?\n/);
  const diags: vscode.Diagnostic[] = [];

  const isInEditorFolder = /[\\/]Editor[\\/]/i.test(fsPath);
  const editorClassMatch =
    /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:UnityEditor(?:\.[A-Za-z0-9_]+)*\.)?(ShaderGUI|BaseShaderGUI|Editor|EditorWindow|PropertyDrawer|MaterialPropertyDrawer)\b/.exec(
      maskedText,
    );
  const isEditorScript = isInEditorFolder || editorClassMatch !== null;

  if (
    /[\\/]Assets[\\/]/i.test(fsPath) &&
    !isInEditorFolder &&
    editorClassMatch !== null &&
    !/#\s*if\b[^\r\n]*\bUNITY_EDITOR\b/.test(text)
  ) {
    const baseTypeName = editorClassMatch[2];
    const matchIdx = editorClassMatch.index;
    const prefix = maskedText.slice(0, matchIdx);
    const lastNl = prefix.lastIndexOf('\n');
    const lineNum = prefix.split('\n').length - 1;
    const colNum = lastNl < 0 ? matchIdx : matchIdx - lastNl - 1;
    const classNameOffset = editorClassMatch[0].indexOf(editorClassMatch[1]);
    diags.push(
      makeDiag(
        lineNum,
        colNum + Math.max(0, classNameOffset),
        editorClassMatch[1].length,
        `[UnitySense] Editor 전용 클래스('${baseTypeName}')가 'Editor' 폴더 외부에 선언되어 Player 어셈블리에서 UnityEditor 참조 오류(CS0246)가 발생할 수 있습니다. 'Editor' 폴더로 이동하거나 '#if UNITY_EDITOR'로 감싸세요.`,
        vscode.DiagnosticSeverity.Warning,
        'UB1004',
      ),
    );
  }

  // 1. UB1002: Performance-critical loop uncached lookups (GetComponent / Camera.main / Find*)
  const perfBlocks = findPerfCriticalMethodBlocks(maskedLines);
  const perfApiRe = /\b(GetComponent(?:InChildren|InParent)?s?(?:\s*<[^>]+>)?\s*\(|TryGetComponent(?:\s*<[^>]+>)?\s*\(|FindObject(?:s)?OfType(?:\s*<[^>]+>)?\s*\(|GameObject\.Find\s*\(|Camera\.main\b)/g;

  for (const block of perfBlocks) {
    for (let l = block.startLine; l <= block.endLine; l++) {
      const mLine = maskedLines[l] ?? '';
      perfApiRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = perfApiRe.exec(mLine)) !== null) {
        const apiName = m[1].replace(/\s*\($/, '').trim();
        diags.push(
          makeDiag(
            l,
            m.index,
            apiName.length,
            `[UnitySense] 성능 민감 컨텍스트(${block.headerName})에서 캐싱되지 않은 '${apiName}' 호출이 감지되었습니다. Awake()에서 참조를 캐싱하세요.`,
            vscode.DiagnosticSeverity.Warning,
            'UB1002',
          ),
        );
      }
    }
  }

  // 2. UB1003: Uncached Shader / Animator string literal property names
  const shaderOrAnimMethodRe = /\b(SetFloat|GetFloat|SetInt|GetInt|SetInteger|GetInteger|SetColor|GetColor|SetVector|GetVector|SetTexture|GetTexture|SetMatrix|GetMatrix|SetBuffer|SetBool|GetBool|SetTrigger|ResetTrigger)\s*\(\s*"([^"]+)"/g;
  // 3. UB3002 & UB3003: Tag / Layer / Scene string validation against ProjectSettingsCache
  const tagCallRe = /\bCompareTag\s*\(\s*"([^"]+)"\s*\)|\.tag\s*(?:==|!=|=)\s*"([^"]+)"/g;
  const layerCallRe = /\bLayerMask\.(?:NameToLayer|GetMask)\s*\(\s*"([^"]+)"/g;
  const sceneCallRe = /\bSceneManager\.(?:LoadScene|LoadSceneAsync)\s*\(\s*"([^"]+)"/g;

  const validTags = new Set(cache.tags);
  const validLayers = new Set(cache.layers.map((l) => l.name));
  const enabledSceneNames = new Set<string>();
  const enabledScenePaths = new Set<string>();
  for (const sc of cache.buildScenes) {
    if (!sc.enabled) continue;
    enabledSceneNames.add(sc.name);
    enabledScenePaths.add(sc.path);
    enabledScenePaths.add(sc.path.replace(/^Assets\//i, '').replace(/\.unity$/i, ''));
  }

  for (let l = 0; l < lines.length; l++) {
    const rawLine = lines[l] ?? '';
    const mLine = maskedLines[l] ?? '';
    if (!rawLine.includes('"')) continue;

    // UB1003
    if (!isEditorScript) {
      shaderOrAnimMethodRe.lastIndex = 0;
      let sm: RegExpExecArray | null;
      while ((sm = shaderOrAnimMethodRe.exec(rawLine)) !== null) {
        // Ensure the method call itself is not inside a comment/string
        if ((mLine[sm.index] ?? ' ') === ' ') continue;
        const methodName = sm[1];
        const literal = sm[2];
        const isAnim = methodName === 'SetTrigger' || methodName === 'ResetTrigger' || methodName === 'SetBool' || methodName === 'GetBool' || methodName === 'SetInteger' || methodName === 'GetInteger';
        const helper = isAnim ? 'Animator.StringToHash' : 'Shader.PropertyToID';
        diags.push(
          makeDiag(
            l,
            sm.index,
            sm[0].length,
            `[UnitySense] ${methodName}에서 문자열 리터럴 "${literal}"이(가) 사용되었습니다. ${helper}로 static readonly int 필드에 캐싱하세요.`,
            vscode.DiagnosticSeverity.Warning,
            'UB1003',
          ),
        );
      }
    }

    // UB3002: Tag
    if (validTags.size > 0) {
      tagCallRe.lastIndex = 0;
      let tm: RegExpExecArray | null;
      while ((tm = tagCallRe.exec(rawLine)) !== null) {
        if ((mLine[tm.index] ?? ' ') === ' ') continue;
        const tagVal = tm[1] ?? tm[2];
        if (tagVal && !validTags.has(tagVal)) {
          diags.push(
            makeDiag(
              l,
              tm.index,
              tm[0].length,
              `[UnitySense] 태그 '${tagVal}'은(는) ProjectSettings/TagManager.asset에 등록되어 있지 않습니다.`,
              vscode.DiagnosticSeverity.Warning,
              'UB3002',
            ),
          );
        }
      }
    }

    // UB3002: Layer
    if (validLayers.size > 0) {
      layerCallRe.lastIndex = 0;
      let lm: RegExpExecArray | null;
      while ((lm = layerCallRe.exec(rawLine)) !== null) {
        if ((mLine[lm.index] ?? ' ') === ' ') continue;
        const layerVal = lm[1];
        if (layerVal && !validLayers.has(layerVal)) {
          diags.push(
            makeDiag(
              l,
              lm.index,
              lm[0].length,
              `[UnitySense] 레이어 '${layerVal}'은(는) ProjectSettings/TagManager.asset에 등록되어 있지 않습니다.`,
              vscode.DiagnosticSeverity.Warning,
              'UB3002',
            ),
          );
        }
      }
    }

    // UB3003: Scene
    if (enabledSceneNames.size > 0) {
      sceneCallRe.lastIndex = 0;
      let scm: RegExpExecArray | null;
      while ((scm = sceneCallRe.exec(rawLine)) !== null) {
        if ((mLine[scm.index] ?? ' ') === ' ') continue;
        const sceneVal = scm[1];
        if (
          sceneVal &&
          !enabledSceneNames.has(sceneVal) &&
          !enabledScenePaths.has(sceneVal) &&
          !enabledScenePaths.has(sceneVal.replace(/\.unity$/i, ''))
        ) {
          diags.push(
            makeDiag(
              l,
              scm.index,
              scm[0].length,
              `[UnitySense] 씬 '${sceneVal}'은(는) EditorBuildSettings.asset의 활성화된 빌드 씬 목록에 없습니다.`,
              vscode.DiagnosticSeverity.Warning,
              'UB3003',
            ),
          );
        }
      }
    }
  }

  // 4. UB2001~UB2004: [BurstCompile] checks (only executed if the file contains [BurstCompile])
  if (/\[\s*BurstCompile\b/.test(maskedText)) {
    const burstBlocks = findAttributedBlocks(maskedLines, /\[\s*BurstCompile\b/);
    const discardBlocks = findAttributedBlocks(maskedLines, /\[\s*BurstDiscard\b/);
    const isInDiscard = (line: number) =>
      discardBlocks.some((db) => line >= db.startLine && line <= db.endLine);

    const typeKindCache = new Map<string, HoverTypeKind>();
    const resolveType = async (
      line: number,
      col: number,
      typeName: string,
    ): Promise<HoverTypeKind> => {
      if (KNOWN_BLITTABLE_OR_UNMANAGED_TYPES.has(typeName)) return 'struct';
      if (KNOWN_MANAGED_REFERENCE_TYPES.has(typeName)) return 'class';
      const cached = typeKindCache.get(typeName);
      if (cached) return cached;
      const resolved = await hoverResolver(doc, new vscode.Position(line, col), typeName);
      typeKindCache.set(typeName, resolved);
      return resolved;
    };

    const exceptionRe = /\b(try|catch|throw)\b/g;
    const managedStringRe = /\bstring\b|\bString\b/g;
    const interpolatedStringRe = /\$@?"/g;
    const newTypeRe = /\bnew\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]+>)?\s*(?:\(|\{|\[)/g;
    const castTypeRe = /\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*[A-Za-z_(]/g;
    const declTypeRe = /^\s*(?:(?:public|private|protected|internal|readonly|static)\s+)*([A-Za-z_][A-Za-z0-9_]*)(?:<[^>]+>)?\s+[A-Za-z_][A-Za-z0-9_]*\s*[;=,)]/;

    for (const block of burstBlocks) {
      for (let l = block.startLine; l <= block.endLine; l++) {
        if (isInDiscard(l)) continue;
        const mLine = maskedLines[l] ?? '';
        const rawLine = lines[l] ?? '';

        // UB2004: try/catch/throw
        exceptionRe.lastIndex = 0;
        let em: RegExpExecArray | null;
        while ((em = exceptionRe.exec(mLine)) !== null) {
          diags.push(
            makeDiag(
              l,
              em.index,
              em[1].length,
              `[UnitySense] [BurstCompile] 컨텍스트 내부에서 예외 처리 구문 '${em[1]}'은(는) 지원되지 않습니다.`,
              vscode.DiagnosticSeverity.Warning,
              'UB2004',
            ),
          );
        }

        // UB2003: managed string type or interpolated string
        managedStringRe.lastIndex = 0;
        let stm: RegExpExecArray | null;
        while ((stm = managedStringRe.exec(mLine)) !== null) {
          diags.push(
            makeDiag(
              l,
              stm.index,
              stm[0].length,
              `[UnitySense] [BurstCompile] 컨텍스트 내부에서 관리 문자열('${stm[0]}')은 허용되지 않습니다. FixedString을 사용하세요.`,
              vscode.DiagnosticSeverity.Error,
              'UB2003',
            ),
          );
        }
        interpolatedStringRe.lastIndex = 0;
        let ism: RegExpExecArray | null;
        while ((ism = interpolatedStringRe.exec(rawLine)) !== null) {
          if ((mLine[ism.index] ?? ' ') === ' ') continue;
          diags.push(
            makeDiag(
              l,
              ism.index,
              ism[0].length,
              `[UnitySense] [BurstCompile] 컨텍스트 내부에서 문자열 보간($\"...\")은 허용되지 않습니다.`,
              vscode.DiagnosticSeverity.Error,
              'UB2003',
            ),
          );
        }

        // UB2001 / UB2002: `new Type(...)`
        newTypeRe.lastIndex = 0;
        let nm: RegExpExecArray | null;
        while ((nm = newTypeRe.exec(mLine)) !== null) {
          const typeName = nm[1];
          if (CSHARP_KEYWORDS.has(typeName)) continue;
          const typeCol = nm.index + nm[0].indexOf(typeName);
          const kind = await resolveType(l, typeCol, typeName);
          if (kind === 'class' || kind === 'delegate') {
            diags.push(
              makeDiag(
                l,
                typeCol,
                typeName.length,
                `[UnitySense] [BurstCompile] 컨텍스트 내부에서 참조 타입 '${typeName}'은(는) 사용할 수 없습니다.`,
                vscode.DiagnosticSeverity.Error,
                'UB2001',
              ),
            );
          }
        }

        // UB2002: explicit cast to object/interface (boxing)
        castTypeRe.lastIndex = 0;
        let cm: RegExpExecArray | null;
        while ((cm = castTypeRe.exec(mLine)) !== null) {
          const typeName = cm[1];
          if (CSHARP_KEYWORDS.has(typeName) && typeName !== 'object') continue;
          const typeCol = cm.index + cm[0].indexOf(typeName);
          if (typeName === 'object' || typeName === 'Object') {
            diags.push(
              makeDiag(
                l,
                typeCol,
                typeName.length,
                `[UnitySense] [BurstCompile] 컨텍스트 내부에서 '${typeName}'(으)로의 박싱(Boxing)은 금지됩니다.`,
                vscode.DiagnosticSeverity.Error,
                'UB2002',
              ),
            );
          } else {
            const kind = await resolveType(l, typeCol, typeName);
            if (kind === 'interface') {
              diags.push(
                makeDiag(
                  l,
                  typeCol,
                  typeName.length,
                  `[UnitySense] [BurstCompile] 컨텍스트 내부에서 인터페이스 '${typeName}'(으)로의 박싱(Boxing)은 금지됩니다.`,
                  vscode.DiagnosticSeverity.Error,
                  'UB2002',
                ),
              );
            }
          }
        }

        // UB2001: field / local variable declaration with reference type
        const dm = declTypeRe.exec(mLine);
        if (dm) {
          const typeName = dm[1];
          if (typeName !== 'string' && typeName !== 'String' && !CSHARP_KEYWORDS.has(typeName)) {
            const typeCol = dm.index + dm[0].indexOf(typeName);
            const kind = await resolveType(l, typeCol, typeName);
            if (kind === 'class' || kind === 'delegate') {
              diags.push(
                makeDiag(
                  l,
                  typeCol,
                  typeName.length,
                  `[UnitySense] [BurstCompile] 컨텍스트 내부에서 참조 타입 '${typeName}'은(는) 사용할 수 없습니다.`,
                  vscode.DiagnosticSeverity.Error,
                  'UB2001',
                ),
              );
            } else if (kind === 'interface') {
              diags.push(
                makeDiag(
                  l,
                  typeCol,
                  typeName.length,
                  `[UnitySense] [BurstCompile] 컨텍스트 내부에서 인터페이스 '${typeName}' 사용(박싱 위험)은 금지됩니다.`,
                  vscode.DiagnosticSeverity.Error,
                  'UB2002',
                ),
              );
            }
          }
        }
      }
    }
  }

  return diags;
}
