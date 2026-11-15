#ifndef CUSTOM_GIT_HELPER_INCLUDED
#define CUSTOM_GIT_HELPER_INCLUDED

float3 CustomGitToneMap(float3 color) {
    return color / (color + 1.0);
}

#endif
