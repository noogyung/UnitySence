Shader "UnityBrain/TestLit"
{
    Properties
    {
        _BaseMap ("Base Map", 2D) = "white" {}
        _BaseColor ("Base Color", Color) = (1, 1, 1, 1)
        _Cutoff ("Alpha Cutoff", Range(0.0, 1.0)) = 0.5
        _Smoothness ("Smoothness", Float) = 0.5
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" }

        HLSLINCLUDE
        #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
        ENDHLSL

        Pass
        {
            Name "ForwardLit"
            HLSLPROGRAM
            #pragma vertex Vert
            #pragma fragment Frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE
            #pragma shader_feature_local _ALPHATEST_ON

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
            #include "./Include/LocalShaderHelper.hlsl"

            struct Varyings {
                float4 positionHCS : SV_POSITION;
                half3 normalWS : TEXCOORD0;
            };

            Varyings Vert(Attributes input) {
                Varyings output;
                output.positionHCS = float4(TransformObjectToWorld(input.positionOS.xyz), 1.0);
                output.normalWS = half3(0, 1, 0);
                return output;
            }

            half4 Frag(Varyings input) : SV_Target {
                InputData data;
                data.positionWS = float3(0, 0, 0);
                data.normalWS = input.normalWS;
                data.viewDirectionWS = half3(0, 0, 1);

                SurfaceData surfaceData;
                surfaceData.albedo = _BaseColor.rgb;
                surfaceData.smoothness = _Smoothness;
                surfaceData.metallic = 0.0;

                half4 lit = UniversalFragmentPBR(data, surfaceData);
                return ComputeShaderHelperTint(lit);
            }
            ENDHLSL
        }
    }
}
