#ifndef UNIVERSAL_LIGHTING_INCLUDED
#define UNIVERSAL_LIGHTING_INCLUDED

#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
#include "./BRDF.hlsl"

struct InputData {
    float3 positionWS;
    half3 normalWS;
    half3 viewDirectionWS;
};

struct SurfaceData {
    half3 albedo;
    half smoothness;
    half metallic;
};

half4 UniversalFragmentPBR(InputData inputData, SurfaceData surfaceData) {
    half3 direct = DirectBRDFSpecular(surfaceData.smoothness, inputData.normalWS);
    return half4(surfaceData.albedo + direct, 1.0);
}

#endif
