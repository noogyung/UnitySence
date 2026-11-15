#ifndef CUSTOM_EMBEDDED_INCLUDED
#define CUSTOM_EMBEDDED_INCLUDED

half3 ApplyEmbeddedRim(half3 baseColor, half fresnel) {
    return baseColor + fresnel;
}

#endif
