#ifndef UNIVERSAL_PIPELINE_CORE_INCLUDED
#define UNIVERSAL_PIPELINE_CORE_INCLUDED

#include "Packages/com.unity.render-pipelines.core/ShaderLibrary/Common.hlsl"

TEXTURE2D(_GlobalEnvTex);
SAMPLER(sampler_GlobalEnvTex);

CBUFFER_START(UnityPerMaterial)
    float4 _BaseMap_ST;
    half4 _BaseColor;
CBUFFER_END

struct Attributes {
    float4 positionOS : POSITION;
    float3 normalOS : NORMAL;
    float2 uv : TEXCOORD0;
};

float3 TransformObjectToWorld(float3 positionOS) {
    return positionOS;
}

#endif
