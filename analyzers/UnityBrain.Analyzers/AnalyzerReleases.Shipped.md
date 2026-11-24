; Shipped analyzer releases
; https://github.com/dotnet/roslyn-analyzers/blob/main/src/Microsoft.CodeAnalysis.Analyzers/ReleaseTrackingAnalyzers.Help.md

## Release 1.1.0

### New Rules
Rule ID | Category | Severity | Notes
--------|----------|----------|-------
UB1001 | UnityBrain.Performance | Warning | IndirectPerformanceCriticalInvocation
UB1002 | UnityBrain.Performance | Warning | UncachedComponentLookup
UB1003 | UnityBrain.Performance | Warning | UncachedShaderOrAnimatorPropertyId
UB2001 | UnityBrain.Burst | Error | BurstReferenceTypeForbidden
UB2002 | UnityBrain.Burst | Error | BurstBoxingForbidden
UB2003 | UnityBrain.Burst | Error | BurstManagedStringForbidden
UB2004 | UnityBrain.Burst | Warning | BurstExceptionHandlingForbidden
UB3001 | UnityBrain.Validation | Warning | UnresolvedInvokeOrCoroutineMethod
UB3002 | UnityBrain.Validation | Warning | UnknownUnityTagOrLayer
UB3003 | UnityBrain.Validation | Warning | SceneNotInBuildSettings
UBSUP0001 | Suppression | Info | SuppressCS0649Rule
UBSUP0002 | Suppression | Info | SuppressCS0169Rule
UBSUP0003 | Suppression | Info | SuppressIDE0051Rule
