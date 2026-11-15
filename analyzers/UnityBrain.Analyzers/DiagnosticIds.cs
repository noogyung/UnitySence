using Microsoft.CodeAnalysis;

namespace UnityBrain.Analyzers;

public static class DiagnosticIds
{
    public const string CategoryPerformance = "UnityBrain.Performance";
    public const string CategoryBurst = "UnityBrain.Burst";
    public const string CategoryValidation = "UnityBrain.Validation";
    public const string CategorySerialization = "UnityBrain.Serialization";

    public const string IndirectPerformanceCriticalInvocation = "UB1001";
    public const string UncachedComponentLookup = "UB1002";
    public const string UncachedShaderOrAnimatorPropertyId = "UB1003";

    public const string BurstReferenceTypeForbidden = "UB2001";
    public const string BurstBoxingForbidden = "UB2002";
    public const string BurstManagedStringForbidden = "UB2003";
    public const string BurstExceptionHandlingForbidden = "UB2004";

    public const string UnresolvedInvokeOrCoroutineMethod = "UB3001";
    public const string UnknownUnityTagOrLayer = "UB3002";
    public const string SceneNotInBuildSettings = "UB3003";

    public const string FormerlySerializedAsSuggested = "UB4001";

    public static readonly DiagnosticDescriptor UB1001Rule = new(
        id: IndirectPerformanceCriticalInvocation,
        title: "Avoid expensive Unity API calls in indirect performance-critical paths",
        messageFormat: "Expensive Unity API '{0}' is called in performance-critical call path ({1})",
        category: CategoryPerformance,
        defaultSeverity: DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "Methods reachable from Update, FixedUpdate, LateUpdate, OnGUI, or OnRenderObject execute frequently and should avoid repeated lookups or allocations.");

    public static readonly DiagnosticDescriptor UB1002Rule = new(
        id: UncachedComponentLookup,
        title: "Cache GetComponent/TryGetComponent calls outside performance-critical loops",
        messageFormat: "Uncached '{0}' call in performance-critical context ({1}); cache the component reference in Awake()",
        category: CategoryPerformance,
        defaultSeverity: DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "Caching component references in Awake() eliminates per-frame GetComponent overhead.");

    public static readonly DiagnosticDescriptor UB1003Rule = new(
        id: UncachedShaderOrAnimatorPropertyId,
        title: "Use cached Shader.PropertyToID or Animator.StringToHash instead of string literal",
        messageFormat: "String literal \"{0}\" used in {1}; extract to static readonly int via {2}",
        category: CategoryPerformance,
        defaultSeverity: DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "Shader and Animator property setters hash strings internally on every call unless cached via PropertyToID or StringToHash.");

    public static readonly DiagnosticDescriptor UB2001Rule = new(
        id: BurstReferenceTypeForbidden,
        title: "Burst-compiled code cannot use managed reference types",
        messageFormat: "Managed reference type '{0}' is forbidden inside [BurstCompile] context",
        category: CategoryBurst,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "Burst supports unmanaged blittable value types and NativeContainers only.");

    public static readonly DiagnosticDescriptor UB2002Rule = new(
        id: BurstBoxingForbidden,
        title: "Burst-compiled code cannot box value types",
        messageFormat: "Value type '{0}' is boxed to '{1}' inside [BurstCompile] context",
        category: CategoryBurst,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "Boxing allocates on the managed heap and is rejected by the Burst compiler.");

    public static readonly DiagnosticDescriptor UB2003Rule = new(
        id: BurstManagedStringForbidden,
        title: "Burst-compiled code cannot format or concatenate managed strings",
        messageFormat: "Managed string operation ({0}) is forbidden inside [BurstCompile] context",
        category: CategoryBurst,
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true,
        description: "Use FixedString types or move logging into [BurstDiscard] methods.");

    public static readonly DiagnosticDescriptor UB2004Rule = new(
        id: BurstExceptionHandlingForbidden,
        title: "Burst-compiled code does not support managed try/catch or throw blocks",
        messageFormat: "Managed exception construct '{0}' is forbidden inside [BurstCompile] context",
        category: CategoryBurst,
        defaultSeverity: DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "Burst does not support managed exception handling via try/catch.");

    public static readonly DiagnosticDescriptor UB3001Rule = new(
        id: UnresolvedInvokeOrCoroutineMethod,
        title: "Unresolved or incompatible method name in Invoke/StartCoroutine",
        messageFormat: "{0}",
        category: CategoryValidation,
        defaultSeverity: DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "Validates string method targets against methods declared on the target class or base types.");

    public static readonly DiagnosticDescriptor UB3002Rule = new(
        id: UnknownUnityTagOrLayer,
        title: "Unknown Unity Tag or Layer name",
        messageFormat: "{0} '{1}' was not found in ProjectSettings/TagManager.asset",
        category: CategoryValidation,
        defaultSeverity: DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "Validates literal Tag and Layer names against ProjectSettingsCache AdditionalFiles.");

    public static readonly DiagnosticDescriptor UB3003Rule = new(
        id: SceneNotInBuildSettings,
        title: "Scene name or path is not enabled in EditorBuildSettings",
        messageFormat: "Scene '{0}' was not found among enabled scenes in EditorBuildSettings.asset",
        category: CategoryValidation,
        defaultSeverity: DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "Validates SceneManager.LoadScene string arguments against buildScenes in ProjectSettingsCache.");
}
