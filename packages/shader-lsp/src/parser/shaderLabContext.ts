import { extractVirtualHlslDocument } from './shaderLabVirtualDoc.ts';

export type ShaderLabContextKind =
  | 'hlsl'
  | 'root'
  | 'properties'
  | 'propertyAttribute'
  | 'subshader'
  | 'pass'
  | 'tags'
  | 'stencil'
  | 'renderState';

export interface ShaderLabDocEntry {
  readonly label: string;
  readonly insertText?: string;
  readonly isSnippet?: boolean;
  readonly detail: string;
  readonly documentation: string;
}

export const SHADERLAB_PROPERTY_ATTRIBUTES: readonly ShaderLabDocEntry[] = [
  { label: 'HDR', detail: '[UnityBrain] Property Attribute', documentation: 'High Dynamic Range 색상/벡터 프로퍼티를 인스펙터에 노출합니다.' },
  { label: 'Normal', detail: '[UnityBrain] Property Attribute', documentation: '노멀 맵 텍스처 슬롯임을 표시하며, 노멀 맵 임포트 설정 경고를 활성화합니다.' },
  { label: 'NoScaleOffset', detail: '[UnityBrain] Property Attribute', documentation: '머티리얼 인스펙터에서 Tiling/Offset 필드를 숨깁니다.' },
  { label: 'MainTexture', detail: '[UnityBrain] Property Attribute', documentation: 'Material.mainTexture가 참조할 기본 텍스처 프로퍼티로 지정합니다.' },
  { label: 'MainColor', detail: '[UnityBrain] Property Attribute', documentation: 'Material.color가 참조할 기본 색상 프로퍼티로 지정합니다.' },
  { label: 'Toggle', insertText: 'Toggle(${1:_KEYWORD})', isSnippet: true, detail: '[UnityBrain] Property Attribute', documentation: '체크박스 토글을 제공하고 활성 시 지정한 셰이더 키워드를 켭니다.' },
  { label: 'ToggleUI', detail: '[UnityBrain] Property Attribute', documentation: '키워드를 토글하지 않고 UI 상에서만 0/1 체크박스로 표시합니다.' },
  { label: 'Enum', insertText: 'Enum(${1:UnityEngine.Rendering.CullMode})', isSnippet: true, detail: '[UnityBrain] Property Attribute', documentation: '드롭다운 열거형 또는 이름/값 쌍 선택기를 인스펙터에 표시합니다.' },
  { label: 'KeywordEnum', insertText: 'KeywordEnum(${1:OptionA, OptionB})', isSnippet: true, detail: '[UnityBrain] Property Attribute', documentation: '선택한 옵션에 해당하는 셰이더 키워드를 활성화하는 드롭다운을 표시합니다.' },
  { label: 'IntRange', detail: '[UnityBrain] Property Attribute', documentation: 'Range 프로퍼티를 정수 슬라이더로 표시합니다.' },
  { label: 'PowerSlider', insertText: 'PowerSlider(${1:3.0})', isSnippet: true, detail: '[UnityBrain] Property Attribute', documentation: '비선형 거듭제곱 곡선으로 슬라이더 값을 조절합니다.' },
  { label: 'Space', insertText: 'Space(${1:10})', isSnippet: true, detail: '[UnityBrain] Property Attribute', documentation: '머티리얼 인스펙터에 세로 여백을 추가합니다.' },
  { label: 'Header', insertText: 'Header(${1:Section Title})', isSnippet: true, detail: '[UnityBrain] Property Attribute', documentation: '머티리얼 인스펙터에 섹션 제목을 표시합니다.' },
  { label: 'HideInInspector', detail: '[UnityBrain] Property Attribute', documentation: '머티리얼 인스펙터에서 이 프로퍼티를 숨깁니다.' },
  { label: 'PerRendererData', detail: '[UnityBrain] Property Attribute', documentation: 'MaterialPropertyBlock을 통해 렌더러별로 전달되는 프로퍼티임을 표시합니다.' },
  { label: 'Gamma', detail: '[UnityBrain] Property Attribute', documentation: 'Float/Vector 값을 sRGB 감마 공간으로 취급합니다.' },
];

export const SHADERLAB_PROPERTY_TYPES: readonly ShaderLabDocEntry[] = [
  { label: '2D', insertText: '2D) = "white" {}', detail: '[UnityBrain] ShaderLab Property Type', documentation: '2D 텍스처 프로퍼티를 선언합니다.' },
  { label: '2DArray', insertText: '2DArray) = "" {}', detail: '[UnityBrain] ShaderLab Property Type', documentation: '2D 텍스처 배열 프로퍼티를 선언합니다.' },
  { label: '3D', insertText: '3D) = "" {}', detail: '[UnityBrain] ShaderLab Property Type', documentation: '3D 볼륨 텍스처 프로퍼티를 선언합니다.' },
  { label: 'Cube', insertText: 'Cube) = "" {}', detail: '[UnityBrain] ShaderLab Property Type', documentation: '큐브맵 텍스처 프로퍼티를 선언합니다.' },
  { label: 'Color', insertText: 'Color) = (1, 1, 1, 1)', detail: '[UnityBrain] ShaderLab Property Type', documentation: 'RGBA 색상 피커 프로퍼티를 선언합니다.' },
  { label: 'Vector', insertText: 'Vector) = (0, 0, 0, 0)', detail: '[UnityBrain] ShaderLab Property Type', documentation: '4성분 벡터(float4) 프로퍼티를 선언합니다.' },
  { label: 'Float', insertText: 'Float) = 0.0', detail: '[UnityBrain] ShaderLab Property Type', documentation: '부동소수점 스칼라 프로퍼티를 선언합니다.' },
  { label: 'Range', insertText: 'Range(${1:0.0}, ${2:1.0})) = ${3:0.5}', isSnippet: true, detail: '[UnityBrain] ShaderLab Property Type', documentation: '최소~최대 범위 슬라이더 프로퍼티를 선언합니다.' },
  { label: 'Int', insertText: 'Int) = 0', detail: '[UnityBrain] ShaderLab Property Type', documentation: '정수 스칼라 프로퍼티를 선언합니다.' },
  { label: 'Integer', insertText: 'Integer) = 0', detail: '[UnityBrain] ShaderLab Property Type', documentation: 'Unity 2021+ 네이티브 정수 프로퍼티를 선언합니다.' },
];

export const SHADERLAB_TAGS: readonly ShaderLabDocEntry[] = [
  { label: 'RenderPipeline', insertText: '"RenderPipeline" = "${1|UniversalPipeline,HDRenderPipeline|}"', isSnippet: true, detail: '[UnityBrain] ShaderLab Tag', documentation: '이 셰이더가 대상으로 하는 SRP(URP / HDRP)를 지정합니다.' },
  { label: 'UniversalPipeline', detail: '[UnityBrain] ShaderLab Tag Value', documentation: 'Universal Render Pipeline(URP) 호환 셰이더임을 지정합니다.' },
  { label: 'HDRenderPipeline', detail: '[UnityBrain] ShaderLab Tag Value', documentation: 'High Definition Render Pipeline(HDRP) 호환 셰이더임을 지정합니다.' },
  { label: 'RenderType', insertText: '"RenderType" = "${1|Opaque,Transparent,TransparentCutout,Background,Overlay|}"', isSnippet: true, detail: '[UnityBrain] ShaderLab Tag', documentation: 'Replacement Shader 및 렌더 패스 분류에 사용되는 렌더 타입을 지정합니다.' },
  { label: 'Queue', insertText: '"Queue" = "${1|Background,Geometry,AlphaTest,Transparent,Overlay|}"', isSnippet: true, detail: '[UnityBrain] ShaderLab Tag', documentation: '렌더링 정렬 큐 순서를 지정합니다 (예: Geometry, Transparent).' },
  { label: 'LightMode', insertText: '"LightMode" = "${1|UniversalForward,UniversalForwardOnly,ShadowCaster,DepthOnly,DepthNormals,DepthNormalsOnly,Meta,SRPDefaultUnlit|}"', isSnippet: true, detail: '[UnityBrain] ShaderLab Pass Tag', documentation: 'Pass가 실행될 파이프라인 라이트 모드를 지정합니다.' },
  { label: 'IgnoreProjector', insertText: '"IgnoreProjector" = "${1|True,False|}"', isSnippet: true, detail: '[UnityBrain] ShaderLab Tag', documentation: 'Built-in Projector의 영향을 무시할지 여부를 지정합니다.' },
  { label: 'DisableBatching', insertText: '"DisableBatching" = "${1|True,False,LODFading|}"', isSnippet: true, detail: '[UnityBrain] ShaderLab Tag', documentation: '오브젝트 공간 정점 애니메이션 시 동적/정적 배칭을 비활성화합니다.' },
  { label: 'PreviewType', insertText: '"PreviewType" = "${1|Sphere,Plane,Skybox|}"', isSnippet: true, detail: '[UnityBrain] ShaderLab Tag', documentation: '머티리얼 인스펙터 미리보기 메시 형태를 지정합니다.' },
  { label: 'ForceNoShadowCasting', insertText: '"ForceNoShadowCasting" = "${1|True,False|}"', isSnippet: true, detail: '[UnityBrain] ShaderLab Tag', documentation: 'SubShader가 그림자를 드리우지 않도록 강제합니다.' },
];

export const SHADERLAB_RENDER_STATES: readonly ShaderLabDocEntry[] = [
  { label: 'Tags', insertText: 'Tags { "${1:RenderPipeline}" = "${2:UniversalPipeline}" }', isSnippet: true, detail: '[UnityBrain] ShaderLab Block', documentation: 'SubShader 또는 Pass의 메타데이터 태그를 정의합니다.' },
  { label: 'LOD', insertText: 'LOD ${1:100}', isSnippet: true, detail: '[UnityBrain] ShaderLab State', documentation: 'Shader Level of Detail 임계값을 설정합니다.' },
  { label: 'Name', insertText: 'Name "${1:ForwardLit}"', isSnippet: true, detail: '[UnityBrain] ShaderLab Pass Name', documentation: 'UsePass에서 참조할 수 있는 Pass 이름을 지정합니다.' },
  { label: 'Blend', insertText: 'Blend ${1|SrcAlpha OneMinusSrcAlpha,One One,One OneMinusSrcAlpha,DstColor Zero,Off|}', isSnippet: true, detail: '[UnityBrain] ShaderLab Render State', documentation: '알파 블렌딩 모드(Source/Destination factor)를 설정합니다.' },
  { label: 'BlendOp', insertText: 'BlendOp ${1|Add,Sub,RevSub,Min,Max|}', isSnippet: true, detail: '[UnityBrain] ShaderLab Render State', documentation: '블렌드 연산자를 설정합니다.' },
  { label: 'Cull', insertText: 'Cull ${1|Back,Front,Off|}', isSnippet: true, detail: '[UnityBrain] ShaderLab Render State', documentation: '폴리곤 컬링 방향(Back, Front, Off)을 설정합니다.' },
  { label: 'ZWrite', insertText: 'ZWrite ${1|On,Off|}', isSnippet: true, detail: '[UnityBrain] ShaderLab Render State', documentation: '깊이 버퍼(Z-Buffer) 쓰기 활성화 여부를 설정합니다.' },
  { label: 'ZTest', insertText: 'ZTest ${1|LEqual,Less,Greater,GEqual,Equal,NotEqual,Always|}', isSnippet: true, detail: '[UnityBrain] ShaderLab Render State', documentation: '깊이 테스트 비교 함수를 설정합니다.' },
  { label: 'ColorMask', insertText: 'ColorMask ${1|RGBA,RGB,A,0|}', isSnippet: true, detail: '[UnityBrain] ShaderLab Render State', documentation: '프레임 버퍼에 기록할 컬러 채널 마스크를 설정합니다.' },
  { label: 'Offset', insertText: 'Offset ${1:-1}, ${2:-1}', isSnippet: true, detail: '[UnityBrain] ShaderLab Render State', documentation: 'Z-파이팅 방지를 위한 깊이 바이어스(factor, units)를 설정합니다.' },
  { label: 'Stencil', insertText: 'Stencil\n{\n\tRef ${1:1}\n\tComp ${2|Always,Equal,NotEqual,Less,Greater|}\n\tPass ${3|Keep,Replace,Zero|}\n}', isSnippet: true, detail: '[UnityBrain] ShaderLab Block', documentation: '스텐실 버퍼 테스트 및 연산 블록을 정의합니다.' },
  { label: 'HLSLPROGRAM', insertText: 'HLSLPROGRAM\n#pragma vertex ${1:vert}\n#pragma fragment ${2:frag}\n$0\nENDHLSL', isSnippet: true, detail: '[UnityBrain] ShaderLab Code Block', documentation: 'Unity HLSL 셰이더 프로그램 블록을 시작합니다.' },
  { label: 'HLSLINCLUDE', insertText: 'HLSLINCLUDE\n$0\nENDHLSL', isSnippet: true, detail: '[UnityBrain] ShaderLab Include Block', documentation: '동일 SubShader/Shader 내 모든 Pass에 공유되는 HLSL 코드를 정의합니다.' },
  { label: 'UsePass', insertText: 'UsePass "${1:Universal Render Pipeline/Lit/ShadowCaster}"', isSnippet: true, detail: '[UnityBrain] ShaderLab Command', documentation: '다른 셰이더에 정의된 명명된 Pass를 재사용합니다.' },
  { label: 'Fallback', insertText: 'Fallback "${1:Hidden/Universal Render Pipeline/FallbackError}"', isSnippet: true, detail: '[UnityBrain] ShaderLab Command', documentation: '지원되는 SubShader가 없을 때 사용할 대체 셰이더를 지정합니다.' },
  { label: 'CustomEditor', insertText: 'CustomEditor "${1:UnityEditor.Rendering.Universal.ShaderGUI.LitShader}"', isSnippet: true, detail: '[UnityBrain] ShaderLab Command', documentation: '머티리얼 인스펙터를 커스터마이징할 ShaderGUI 클래스명을 지정합니다.' },
];

export const SHADERLAB_STENCIL_ITEMS: readonly ShaderLabDocEntry[] = [
  { label: 'Ref', insertText: 'Ref ${1:1}', isSnippet: true, detail: '[UnityBrain] Stencil State', documentation: '스텐실 비교 기준값(0~255)을 지정합니다.' },
  { label: 'ReadMask', insertText: 'ReadMask ${1:255}', isSnippet: true, detail: '[UnityBrain] Stencil State', documentation: '스텐실 읽기 비트 마스크를 지정합니다.' },
  { label: 'WriteMask', insertText: 'WriteMask ${1:255}', isSnippet: true, detail: '[UnityBrain] Stencil State', documentation: '스텐실 쓰기 비트 마스크를 지정합니다.' },
  { label: 'Comp', insertText: 'Comp ${1|Always,Never,Less,Equal,LEqual,Greater,NotEqual,GEqual|}', isSnippet: true, detail: '[UnityBrain] Stencil State', documentation: '스텐실 버퍼 비교 함수를 지정합니다.' },
  { label: 'Pass', insertText: 'Pass ${1|Keep,Zero,Replace,IncrSat,DecrSat,Invert,IncrWrap,DecrWrap|}', isSnippet: true, detail: '[UnityBrain] Stencil State', documentation: '스텐실 및 깊이 테스트 통과 시 수행할 연산을 지정합니다.' },
  { label: 'Fail', insertText: 'Fail ${1|Keep,Zero,Replace,IncrSat,DecrSat,Invert,IncrWrap,DecrWrap|}', isSnippet: true, detail: '[UnityBrain] Stencil State', documentation: '스텐실 테스트 실패 시 수행할 연산을 지정합니다.' },
  { label: 'ZFail', insertText: 'ZFail ${1|Keep,Zero,Replace,IncrSat,DecrSat,Invert,IncrWrap,DecrWrap|}', isSnippet: true, detail: '[UnityBrain] Stencil State', documentation: '스텐실은 통과하고 깊이 테스트에서 실패할 때 수행할 연산을 지정합니다.' },
];

export const SHADERLAB_HOVER_DOCS: ReadonlyMap<string, ShaderLabDocEntry> = new Map(
  [
    ...SHADERLAB_PROPERTY_ATTRIBUTES,
    ...SHADERLAB_PROPERTY_TYPES,
    ...SHADERLAB_TAGS,
    ...SHADERLAB_RENDER_STATES,
    ...SHADERLAB_STENCIL_ITEMS,
    { label: 'SrcAlpha', detail: '[UnityBrain] Blend Factor', documentation: '소스 알파 값(As, As, As, As)을 블렌드 인수로 사용합니다.' },
    { label: 'OneMinusSrcAlpha', detail: '[UnityBrain] Blend Factor', documentation: '(1 - As)를 블렌드 인수로 사용합니다. 표준 알파 블렌딩에 쓰입니다.' },
    { label: 'One', detail: '[UnityBrain] Blend Factor', documentation: '가중치 1을 곱합니다 (Additive 블렌딩 등).' },
    { label: 'Zero', detail: '[UnityBrain] Blend Factor', documentation: '가중치 0을 곱하여 해당 항을 제거합니다.' },
    { label: 'Back', detail: '[UnityBrain] Cull Mode', documentation: '뒷면(Back-facing) 폴리곤을 컬링합니다 (기본값).' },
    { label: 'Front', detail: '[UnityBrain] Cull Mode', documentation: '앞면(Front-facing) 폴리곤을 컬링합니다.' },
    { label: 'Off', detail: '[UnityBrain] State Value', documentation: '해당 렌더 상태(컬링/ZWrite/블렌딩)를 끕니다.' },
    { label: 'On', detail: '[UnityBrain] State Value', documentation: '해당 렌더 상태(ZWrite 등)를 켭니다.' },
    { label: 'LEqual', detail: '[UnityBrain] ZTest / Stencil Comp', documentation: '기존 깊이 값보다 작거나 같으면 통과합니다 (기본값).' },
    { label: 'Always', detail: '[UnityBrain] ZTest / Stencil Comp', documentation: '깊이/스텐실 테스트를 항상 통과시킵니다.' },
    { label: 'Properties', detail: '[UnityBrain] ShaderLab Block', documentation: 'Unity 머티리얼 인스펙터에 노출할 셰이더 프로퍼티를 선언합니다.' },
    { label: 'SubShader', detail: '[UnityBrain] ShaderLab Block', documentation: '렌더 파이프라인/하드웨어 수준별 셰이더 구현 블록입니다.' },
    { label: 'Pass', detail: '[UnityBrain] ShaderLab Block', documentation: '한 번의 지오메트리 드로우 콜을 정의하는 패스 블록입니다.' },
  ].map((entry) => [entry.label, entry]),
);

function maskShaderLabTriviaAndBlocks(
  documentText: string,
  blocks: readonly { codeStartOffset: number; codeEndOffset: number }[],
): string {
  const chars = Array.from(documentText);
  for (const blk of blocks) {
    for (let k = blk.codeStartOffset; k < blk.codeEndOffset && k < chars.length; k++) {
      if (chars[k] !== '\n' && chars[k] !== '\r') {
        chars[k] = ' ';
      }
    }
  }
  let i = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < chars.length) {
    const ch = chars[i];
    const next = chars[i + 1];
    if (ch === '\n' || ch === '\r') {
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inLineComment) {
      chars[i] = ' ';
      i++;
      continue;
    }
    if (inBlockComment) {
      chars[i] = ' ';
      if (ch === '*' && next === '/') {
        chars[i + 1] = ' ';
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inString) {
      if (ch === '\\' && i + 1 < chars.length && chars[i + 1] !== '\n' && chars[i + 1] !== '\r') {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
        continue;
      }
      chars[i] = ' ';
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"') {
      chars[i] = ' ';
      inString = true;
      i++;
      continue;
    }
    i++;
  }
  return chars.join('');
}

export function detectShaderLabContext(
  documentText: string,
  line: number,
  character: number,
  filePath = '',
): ShaderLabContextKind {
  const virtualDoc = extractVirtualHlslDocument(documentText, filePath);
  if (!virtualDoc.isShaderLab) {
    return 'hlsl';
  }
  const insideHlsl = virtualDoc.blocks.some(
    (b) => line >= b.startLine && line <= b.endLine,
  );
  if (insideHlsl) {
    return 'hlsl';
  }

  const masked = maskShaderLabTriviaAndBlocks(documentText, virtualDoc.blocks);
  const maskedLines = masked.split(/\r?\n/);
  const rawLines = documentText.split(/\r?\n/);
  const currentLinePrefix = (rawLines[line] ?? '').slice(0, character);
  const maskedCurrentPrefix = (maskedLines[line] ?? '').slice(0, character);

  const stack: string[] = [];
  let pendingBlock: string | null = null;
  for (let i = 0; i <= line && i < maskedLines.length; i++) {
    const cleaned = i === line ? maskedCurrentPrefix : maskedLines[i];
    const tokenRe = /\b(Shader|Properties|SubShader|Pass|Tags|Stencil|Category)\b|([{}])/g;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(cleaned)) !== null) {
      if (m[1]) {
        if (!(stack[stack.length - 1] === 'Stencil' && m[1] === 'Pass')) {
          pendingBlock = m[1];
        }
      } else if (m[2] === '{') {
        stack.push(pendingBlock ?? 'block');
        pendingBlock = null;
      } else if (m[2] === '}' && stack.length > 0) {
        stack.pop();
        pendingBlock = null;
      }
    }
  }

  const top = stack[stack.length - 1];
  if (top === 'Properties') {
    const openBracket = currentLinePrefix.lastIndexOf('[');
    const closeBracket = currentLinePrefix.lastIndexOf(']');
    if (openBracket > closeBracket) {
      return 'propertyAttribute';
    }
    return 'properties';
  }
  if (top === 'Tags') return 'tags';
  if (top === 'Stencil') return 'stencil';
  if (top === 'Pass') return 'pass';
  if (top === 'SubShader') return 'subshader';
  if (top === 'Shader' || stack.length === 0) return 'root';
  return 'renderState';
}
