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
    name: 'TEXTURE2D_X_HALF',
    signature: 'TEXTURE2D_X_HALF(textureName)',
    description: 'Declares a half-precision XR/Stereo-aware Texture2D or Texture2DArray.',
    pipeline: 'CoreRP',
  },
  {
    name: 'TEXTURE2D_X_FLOAT',
    signature: 'TEXTURE2D_X_FLOAT(textureName)',
    description: 'Declares a full-precision float XR/Stereo-aware Texture2D or Texture2DArray.',
    pipeline: 'CoreRP',
  },
  {
    name: 'RW_TEXTURE2D',
    signature: 'RW_TEXTURE2D(type, textureName)',
    description: 'Declares a read-write UAV 2D texture resource in HLSL/CoreRP.',
    pipeline: 'CoreRP',
  },
  {
    name: 'RW_TEXTURE2D_X',
    signature: 'RW_TEXTURE2D_X(type, textureName)',
    description: 'Declares a single-pass XR/Stereo-aware read-write UAV 2D texture resource.',
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
    name: 'SAMPLE_TEXTURE2D_X',
    signature: 'SAMPLE_TEXTURE2D_X(textureName, samplerName, coord2)',
    description: 'Cross-platform XR/Single-Pass Stereo 2D texture sample macro.',
    pipeline: 'CoreRP',
  },
  {
    name: 'SAMPLE_TEXTURE2D_X_LOD',
    signature: 'SAMPLE_TEXTURE2D_X_LOD(textureName, samplerName, coord2, lod)',
    description: 'Cross-platform XR/Single-Pass Stereo explicit mip-level 2D texture sample macro.',
    pipeline: 'CoreRP',
  },
  {
    name: 'LOAD_TEXTURE2D',
    signature: 'LOAD_TEXTURE2D(textureName, unCoord2)',
    description: 'Loads a texel from a 2D texture at integer texel coordinates without filtering.',
    pipeline: 'CoreRP',
  },
  {
    name: 'LOAD_TEXTURE2D_X',
    signature: 'LOAD_TEXTURE2D_X(textureName, unCoord2)',
    description: 'Loads a texel from a single-pass XR/Stereo 2D texture at integer texel coordinates.',
    pipeline: 'CoreRP',
  },
  {
    name: 'UNITY_DOTS_INSTANCING_START',
    signature: 'UNITY_DOTS_INSTANCING_START(name)',
    description: 'Begins a Unity DOTS Entities Graphics per-instance metadata/property block.',
    pipeline: 'CoreRP',
  },
  {
    name: 'UNITY_DOTS_INSTANCING_END',
    signature: 'UNITY_DOTS_INSTANCING_END(name)',
    description: 'Closes a Unity DOTS instancing property block.',
    pipeline: 'CoreRP',
  },
  {
    name: 'UNITY_DOTS_INSTANCED_PROP',
    signature: 'UNITY_DOTS_INSTANCED_PROP(type, var)',
    description: 'Declares a per-instance shader property inside a UNITY_DOTS_INSTANCING_START block.',
    pipeline: 'CoreRP',
  },
  {
    name: 'UNITY_ACCESS_DOTS_INSTANCED_PROP',
    signature: 'UNITY_ACCESS_DOTS_INSTANCED_PROP(type, var)',
    description: 'Reads a DOTS instanced property value for the current draw instance.',
    pipeline: 'CoreRP',
  },
  {
    name: 'UNITY_ACCESS_DOTS_INSTANCED_PROP_WITH_DEFAULT',
    signature: 'UNITY_ACCESS_DOTS_INSTANCED_PROP_WITH_DEFAULT(type, var)',
    description: 'Reads a DOTS instanced property value or falls back to the default CBUFFER value.',
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
  {
    name: 'UNITY_DECLARE_TEX2D',
    signature: 'UNITY_DECLARE_TEX2D(tex)',
    description: 'Legacy Built-in RP macro declaring both Texture2D and SamplerState.',
    pipeline: 'Built-in',
  },
  {
    name: 'UNITY_DECLARE_TEX2DARRAY',
    signature: 'UNITY_DECLARE_TEX2DARRAY(tex)',
    description: 'Legacy Built-in RP macro declaring Texture2DArray and SamplerState.',
    pipeline: 'Built-in',
  },
  {
    name: 'UNITY_DECLARE_TEXCUBE',
    signature: 'UNITY_DECLARE_TEXCUBE(tex)',
    description: 'Legacy Built-in RP macro declaring TextureCube and SamplerState.',
    pipeline: 'Built-in',
  },
  {
    name: 'UNITY_DECLARE_SCREENSPACE_TEXTURE',
    signature: 'UNITY_DECLARE_SCREENSPACE_TEXTURE(tex)',
    description: 'Declares XR/Single-Pass stereo-compatible screen space texture.',
    pipeline: 'Built-in',
  },
  {
    name: 'UNITY_SAMPLE_TEX2D',
    signature: 'UNITY_SAMPLE_TEX2D(tex, coord)',
    description: 'Samples a UNITY_DECLARE_TEX2D texture using its paired sampler.',
    pipeline: 'Built-in',
  },
  {
    name: 'UNITY_SAMPLE_TEX2D_SAMPLER',
    signature: 'UNITY_SAMPLE_TEX2D_SAMPLER(tex, samplertex, coord)',
    description: 'Samples a UNITY_DECLARE_TEX2D texture using another texture sampler.',
    pipeline: 'Built-in',
  },
  {
    name: 'TEXTURE2D_SHADOW_PARAM',
    signature: 'TEXTURE2D_SHADOW_PARAM(shadowMap, sampler_shadowMap)',
    description: 'Expands into Texture2D and SamplerComparisonState parameters.',
    pipeline: 'CoreRP',
  },
  {
    name: 'TEXTURE2D_SHADOW_ARGS',
    signature: 'TEXTURE2D_SHADOW_ARGS(shadowMap, sampler_shadowMap)',
    description: 'Forwards shadow Texture2D and SamplerComparisonState arguments.',
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
        /^(\s*)(TEXTURE2D(?:_X(?:_HALF|_FLOAT)?|_ARRAY|_SHADOW|_FLOAT|_HALF)?|TEXTURE3D|TEXTURECUBE(?:_ARRAY)?|RW_TEXTURE2D(?:_X)?|UNITY_DECLARE_TEX2D(?:_NOSAMPLER|_ARRAY|ARRAY)?|UNITY_DECLARE_TEXCUBE|UNITY_DECLARE_SCREENSPACE_TEXTURE)\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,\s*([A-Za-z_][A-Za-z0-9_]*)\s*)?\)\s*;(.*)$/.exec(
          line,
        );
      if (texMatch) {
        const [, indent, macroName, arg1, arg2, trailing] = texMatch;
        const isRwTwoArg = macroName.startsWith('RW_TEXTURE2D') && Boolean(arg2);
        const texName = isRwTwoArg ? arg2! : arg1;
        const typeMap: Record<string, string> = {
          TEXTURE3D: 'Texture3D',
          TEXTURECUBE: 'TextureCube',
          UNITY_DECLARE_TEXCUBE: 'TextureCube',
          TEXTURECUBE_ARRAY: 'TextureCubeArray',
          TEXTURE2D_ARRAY: 'Texture2DArray',
          UNITY_DECLARE_TEX2DARRAY: 'Texture2DArray',
          UNITY_DECLARE_TEX2D_ARRAY: 'Texture2DArray',
          RW_TEXTURE2D: isRwTwoArg ? `RWTexture2D<${arg1}>` : 'RWTexture2D',
          RW_TEXTURE2D_X: isRwTwoArg ? `RWTexture2D<${arg1}>` : 'RWTexture2D',
        };
        const hlslType = typeMap[macroName] ?? 'Texture2D';
        const needsLegacySampler =
          macroName.startsWith('UNITY_DECLARE_') && !macroName.endsWith('_NOSAMPLER');
        const col = line.indexOf(texName);
        synthesizedSymbols.push({
          name: texName,
          kind: 'variable',
          returnType: hlslType,
          signature: `${hlslType} ${texName}`,
          documentation: `Expanded from ${macroName}(${isRwTwoArg ? `${arg1}, ${texName}` : texName})`,
          uri: fileUri,
          line: i,
          column: col >= 0 ? col : 0,
        });
        if (needsLegacySampler) {
          const smpName = `sampler${texName}`;
          synthesizedSymbols.push({
            name: smpName,
            kind: 'variable',
            returnType: 'SamplerState',
            signature: `SamplerState ${smpName}`,
            documentation: `Paired sampler synthesized from ${macroName}(${texName})`,
            uri: fileUri,
            line: i,
            column: col >= 0 ? col : 0,
          });
          normalized = `${indent}${hlslType} ${texName}; SamplerState ${smpName};${trailing}`;
        } else {
          normalized = `${indent}${hlslType} ${texName};${trailing}`;
        }
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
        /^(\s*)(?:CBUFFER_START(?:_WITH_SRP)?|UNITY_INSTANCING_BUFFER_START)\(\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*,\s*[^)]*)?\)\s*(.*)$/.exec(
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
        /^(\s*)(UNITY_DEFINE_INSTANCED_PROP|UNITY_DOTS_INSTANCED_PROP)\(\s*([A-Za-z0-9_<> ]+?)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*;?(.*)$/.exec(
          line,
        );
      if (instPropMatch) {
        const [, indent, macroName, propType, propName, trailing] = instPropMatch;
        const cleanType = propType.trim();
        normalized = `${indent}${cleanType} ${propName};${trailing}`;
        const col = line.indexOf(propName);
        synthesizedSymbols.push({
          name: propName,
          kind: 'variable',
          returnType: cleanType,
          signature: `${cleanType} ${propName}`,
          documentation: `Expanded from ${macroName}(${cleanType}, ${propName})`,
          uri: fileUri,
          line: i,
          column: col >= 0 ? col : 0,
        });
        outLines.push(hasCr ? `${normalized}\r` : normalized);
        continue;
      }

      if (!/^\s*#/.test(normalized)) {
        normalized = normalized.replace(
          /\bUNITY_DOTS_INSTANCED_PROP\(\s*([A-Za-z0-9_<> ]+?)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*;?/g,
          (_full, rawType: string, propName: string, offset: number) => {
            const cleanType = rawType.trim();
            const col = line.indexOf(propName, offset);
            synthesizedSymbols.push({
              name: propName,
              kind: 'variable',
              returnType: cleanType,
              signature: `${cleanType} ${propName}`,
              documentation: `Expanded from UNITY_DOTS_INSTANCED_PROP(${cleanType}, ${propName})`,
              uri: fileUri,
              line: i,
              column: col >= 0 ? col : 0,
            });
            return `${cleanType} ${propName};`;
          },
        );
      }

      // Inline macro normalizations while strictly keeping line count identical
      normalized = normalized
        .replace(
          /\bTEXTURE2D_PARAM\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g,
          'Texture2D $1, SamplerState $2',
        )
        .replace(
          /\bTEXTURE2D_SHADOW_PARAM\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g,
          'Texture2D $1, SamplerComparisonState $2',
        )
        .replace(
          /\b(?:TEXTURE2D_ARGS|TEXTURE2D_SHADOW_ARGS)\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g,
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
