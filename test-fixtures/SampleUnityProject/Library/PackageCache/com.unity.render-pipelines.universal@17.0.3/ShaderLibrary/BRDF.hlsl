#ifndef UNIVERSAL_BRDF_INCLUDED
#define UNIVERSAL_BRDF_INCLUDED

half3 DirectBRDFSpecular(half smoothness, half3 normalWS) {
    return normalWS * smoothness;
}

#endif
