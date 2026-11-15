#ifndef CUSTOM_LOCAL_INCLUDED
#define CUSTOM_LOCAL_INCLUDED

float LocalNoise2D(float2 uv) {
    return frac(sin(dot(uv, float2(12.9898, 78.233))) * 43758.5453);
}

#endif
