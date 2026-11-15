#ifndef UNITY_CG_INCLUDED
#define UNITY_CG_INCLUDED

struct appdata_base {
    float4 vertex : POSITION;
    float3 normal : NORMAL;
    float4 texcoord : TEXCOORD0;
};

float4 UnityObjectToClipPos(float3 pos) {
    return float4(pos, 1.0);
}

#endif
