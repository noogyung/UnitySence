import type { HlslSymbolEntry } from '../../../extension/src/contracts/index.ts';

export interface UnityMacroSpec {
  name: string;
  signature: string;
  description: string;
  pipeline: 'Built-in' | 'URP' | 'HDRP' | 'CoreRP';
}

export const UNITY_BUILTIN_MACROS: readonly UnityMacroSpec[] = [
  {
    name: 'TEXTURE2D',
    signature: 'TEXTURE2D(textureName)',
    description: 'Declares a 2D texture resource in CoreRP/URP/HDRP cross-platform HLSL.',
    pipeline: 'CoreRP',
  },
  {
    name: 'TEXTURE2D_X',
    signature: 'TEXTURE2D_X(textureName)',
    description: 'Declares a single-pass XR/Stereo-aware Texture2D or Texture2DArray.',
    pipeline: 'CoreRP',
  },
  {
    name: 'TEXTURE2D_ARRAY',
    signature: 'TEXTURE2D_ARRAY(textureName)',
    description: 'Declares a 2D texture array resource.',
    pipeline: 'CoreRP',
  },
  {
    name: 'TEXTURE3D',
    signature: 'TEXTURE3D(textureName)',
    description: 'Declares a 3D volume texture resource.',
    pipeline: 'CoreRP',
  },
  {
    name: 'TEXTURECUBE',
    signature: 'TEXTURECUBE(textureName)',
    description: 'Declares a cubemap texture resource.',
    pipeline: 'CoreRP',
  },
  {
    name: 'SAMPLER',
    signature: 'SAMPLER(samplerName)',
    description: 'Declares a SamplerState object paired with a Unity texture declaration.',
    pipeline: 'CoreRP',
  },
  {
    name: 'TEXTURE2D_PARAM',
    signature: 'TEXTURE2D_PARAM(textureName, samplerName)',
    description: 'Expands into Texture2D + SamplerState function parameter list.',
    pipeline: 'CoreRP',
  },
  {
    name: 'TEXTURE2D_ARGS',
    signature: 'TEXTURE2D_ARGS(textureName, samplerName)',
    description: 'Forwards Texture2D and SamplerState arguments to helper functions.',
    pipeline: 'CoreRP',
  },
  {
    name: 'SAMPLE_TEXTURE2D',
    signature: 'SAMPLE_TEXTURE2D(textureName, samplerName, coord2)',
    description: 'Cross-platform 2D texture sample macro.',
    pipeline: 'CoreRP',
  },
  {
    name: 'SAMPLE_TEXTURE2D_LOD',
    signature: 'SAMPLE_TEXTURE2D_LOD(textureName, samplerName, coord2, lod)',
    description: 'Cross-platform explicit mip-level 2D texture sample macro.',
    pipeline: 'CoreRP',
  },
  {
    name: 'SAMPLE_TEXTURE2D_BIAS',
    signature: 'SAMPLE_TEXTURE2D_BIAS(textureName, samplerName, coord2, bias)',
    description: 'Cross-platform biased-mip 2D texture sample macro.',
    pipeline: 'CoreRP',
  },
  {
    name: 'CBUFFER_START',
    signature: 'CBUFFER_START(name)',
    description: 'Begins an SRP-Batcher compatible constant buffer declaration.',
    pipeline: 'CoreRP',
  },
  {
    name: 'CBUFFER_END',
    signature: 'CBUFFER_END',
    description: 'Closes a CBUFFER_START constant buffer declaration.',
    pipeline: 'CoreRP',
  },
  {
    name: 'UNITY_INSTANCING_BUFFER_START',
    signature: 'UNITY_INSTANCING_BUFFER_START(name)',
    description: 'Begins a GPU instancing per-instance constant buffer block.',
    pipeline: 'Built-in',
  },
  {
    name: 'UNITY_INSTANCING_BUFFER_END',
    signature: 'UNITY_INSTANCING_BUFFER_END(name)',
    description: 'Closes a GPU instancing buffer block.',
    pipeline: 'Built-in',
  },
  {
    name: 'UNITY_DEFINE_INSTANCED_PROP',
    signature: 'UNITY_DEFINE_INSTANCED_PROP(type, var)',
    description: 'Defines a per-instance shader property inside a UNITY_INSTANCING_BUFFER block.',
    pipeline: 'Built-in',
  },
  {
    name: 'UNITY_ACCESS_INSTANCED_PROP',
    signature: 'UNITY_ACCESS_INSTANCED_PROP(arrName, propName)',
    description: 'Reads a GPU instanced property value for the current draw instance.',
    pipeline: 'Built-in',
  },
  {
    name: 'UNITY_SETUP_INSTANCE_ID',
    signature: 'UNITY_SETUP_INSTANCE_ID(input)',
    description: 'Sets up unity_InstanceID for GPU instanced vertex/fragment shaders.',
    pipeline: 'Built-in',
  },
  {
    name: 'UNITY_TRANSFER_INSTANCE_ID',
    signature: 'UNITY_TRANSFER_INSTANCE_ID(input, output)',
    description: 'Copies instance ID from vertex input to vertex output.',
    pipeline: 'Built-in',
  },
  {
    name: 'UNITY_INITIALIZE_OUTPUT',
    signature: 'UNITY_INITIALIZE_OUTPUT(type, name)',
    description: 'Zero-initializes an output struct in Unity HLSL/CG.',
    pipeline: 'Built-in',
  },
  {
    name: 'UNITY_VERTEX_INPUT_INSTANCE_ID',
    signature: 'UNITY_VERTEX_INPUT_INSTANCE_ID',
    description: 'Declares instanceID semantic field inside Attributes/Varyings structs.',
    pipeline: 'Built-in',
  },
  {
    name: 'UNITY_VERTEX_OUTPUT_STEREO',
    signature: 'UNITY_VERTEX_OUTPUT_STEREO',
    description: 'Declares stereoTargetEyeIndex field for single-pass instanced VR.',
    pipeline: 'CoreRP',
  },
];

export interface MacroPrepassResult {
  normalizedText: string;
  synthesizedSymbols: HlslSymbolEntry[];
  lineMap: number[];
}

export class UnityHlslMacroPrepass {
  public getBuiltinMacro(name: string): UnityMacroSpec | undefined {
    return UNITY_BUILTIN_MACROS.find((m) => m.name === name);
  }

  public preprocess(sourceText: string, fileUri = ''): MacroPrepassResult {
    const rawLines = sourceText.split('\n');
    const outLines: string[] = [];
    const lineMap: number[] = [];
    const synthesizedSymbols: HlslSymbolEntry[] = [];

    for (let i = 0; i < rawLines.length; i++) {
      const rawLine = rawLines[i];
      const hasCr = rawLine.endsWith('\r');
      const line = hasCr ? rawLine.slice(0, -1) : rawLine;
      lineMap.push(i);

      let normalized = line;

      const texMatch =
        /^(\s*)(TEXTURE2D(?:_X|_ARRAY|_SHADOW|_FLOAT|_HALF)?|TEXTURE3D|TEXTURECUBE(?:_ARRAY)?)\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*;(.*)$/.exec(
          line,
        );
      if (texMatch) {
        const [, indent, macroName, texName, trailing] = texMatch;
        const typeMap: Record<string, string> = {
          TEXTURE3D: 'Texture3D',
          TEXTURECUBE: 'TextureCube',
          TEXTURECUBE_ARRAY: 'TextureCubeArray',
          TEXTURE2D_ARRAY: 'Texture2DArray',
        };
        const hlslType = typeMap[macroName] ?? 'Texture2D';
        normalized = `${indent}${hlslType} ${texName};${trailing}`;
        const col = line.indexOf(texName);
        synthesizedSymbols.push({
          name: texName,
          kind: 'variable',
          returnType: hlslType,
          signature: `${hlslType} ${texName}`,
          documentation: `Expanded from ${macroName}(${texName})`,
          uri: fileUri,
          line: i,
          column: col >= 0 ? col : 0,
        });
        outLines.push(hasCr ? `${normalized}\r` : normalized);
        continue;
      }

      const smpMatch = /^(\s*)SAMPLER(?:_CMP)?\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*;(.*)$/.exec(line);
      if (smpMatch) {
        const [, indent, smpName, trailing] = smpMatch;
        normalized = `${indent}SamplerState ${smpName};${trailing}`;
        const col = line.indexOf(smpName);
        synthesizedSymbols.push({
          name: smpName,
          kind: 'variable',
          returnType: 'SamplerState',
          signature: `SamplerState ${smpName}`,
          documentation: `Expanded from SAMPLER(${smpName})`,
          uri: fileUri,
          line: i,
          column: col >= 0 ? col : 0,
        });
        outLines.push(hasCr ? `${normalized}\r` : normalized);
        continue;
      }

      const cbStartMatch =
        /^(\s*)(?:CBUFFER_START|UNITY_INSTANCING_BUFFER_START)\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)(.*)$/.exec(
          line,
        );
      if (cbStartMatch) {
        const [, indent, cbName, trailing] = cbStartMatch;
        normalized = `${indent}cbuffer ${cbName} {${trailing}`;
        const col = line.indexOf(cbName);
        synthesizedSymbols.push({
          name: cbName,
          kind: 'cbuffer',
          signature: `cbuffer ${cbName}`,
          uri: fileUri,
          line: i,
          column: col >= 0 ? col : 0,
        });
        outLines.push(hasCr ? `${normalized}\r` : normalized);
        continue;
      }

      if (/^\s*(?:CBUFFER_END|UNITY_INSTANCING_BUFFER_END)\b/.test(line)) {
        normalized = line.replace(
          /(?:CBUFFER_END|UNITY_INSTANCING_BUFFER_END)(?:\([^)]*\))?/,
          '};',
        );
        outLines.push(hasCr ? `${normalized}\r` : normalized);
        continue;
      }

      const instPropMatch =
        /^(\s*)UNITY_DEFINE_INSTANCED_PROP\(\s*([A-Za-z0-9_<> ]+?)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*;?(.*)$/.exec(
          line,
        );
      if (instPropMatch) {
        const [, indent, propType, propName, trailing] = instPropMatch;
        normalized = `${indent}${propType.trim()} ${propName};${trailing}`;
        const col = line.indexOf(propName);
        synthesizedSymbols.push({
          name: propName,
          kind: 'variable',
          returnType: propType.trim(),
          signature: `${propType.trim()} ${propName}`,
          uri: fileUri,
          line: i,
          column: col >= 0 ? col : 0,
        });
        outLines.push(hasCr ? `${normalized}\r` : normalized);
        continue;
      }

      // Inline macro normalizations while strictly keeping line count identical
      normalized = normalized
        .replace(
          /\bTEXTURE2D_PARAM\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g,
          'Texture2D $1, SamplerState $2',
        )
        .replace(
          /\bTEXTURE2D_ARGS\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g,
          '$1, $2',
        )
        .replace(/\bhalf([234](?:x[234])?)?\b/g, 'float$1')
        .replace(/\breal([234](?:x[234])?)?\b/g, 'float$1')
        .replace(/\bfixed([234](?:x[234])?)?\b/g, 'float$1')
        .replace(/\bUNITY_VERTEX_INPUT_INSTANCE_ID\b/g, 'uint instanceID : SV_InstanceID;')
        .replace(/\bUNITY_VERTEX_OUTPUT_STEREO\b/g, 'uint stereoTargetEyeIndex : SV_RenderTargetArrayIndex;');

      outLines.push(hasCr ? `${normalized}\r` : normalized);
    }

    return {
      normalizedText: outLines.join('\n'),
      synthesizedSymbols,
      lineMap,
    };
  }
}
