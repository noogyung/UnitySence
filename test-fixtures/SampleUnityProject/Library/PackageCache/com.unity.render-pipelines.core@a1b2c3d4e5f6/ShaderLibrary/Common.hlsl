#ifndef UNITY_RP_COMMON_INCLUDED
#define UNITY_RP_COMMON_INCLUDED

#define SAMPLE_TEXTURE2D_SAFE(tex, smp, uv) SAMPLE_TEXTURE2D(tex, smp, uv)

float4 UnpackNormalCommon(float4 packedNormal) {
    return packedNormal * 2.0 - 1.0;
}

#endif
