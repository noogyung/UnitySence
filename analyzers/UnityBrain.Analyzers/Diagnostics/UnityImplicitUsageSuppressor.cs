using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using UnityBrain.Analyzers.CallGraph;

namespace UnityBrain.Analyzers.Diagnostics;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class UnityImplicitUsageSuppressor : DiagnosticSuppressor
{
    private static readonly HashSet<string> UnityEventMethodNames = new(StringComparer.Ordinal)
    {
        "Awake", "Start", "Update", "FixedUpdate", "LateUpdate",
        "OnEnable", "OnDisable", "OnDestroy", "OnGUI", "OnValidate", "Reset",
        "OnTriggerEnter", "OnTriggerStay", "OnTriggerExit",
        "OnTriggerEnter2D", "OnTriggerStay2D", "OnTriggerExit2D",
        "OnCollisionEnter", "OnCollisionStay", "OnCollisionExit",
        "OnCollisionEnter2D", "OnCollisionStay2D", "OnCollisionExit2D",
        "OnMouseDown", "OnMouseUp", "OnMouseDrag", "OnMouseEnter", "OnMouseExit", "OnMouseOver", "OnMouseUpAsButton",
        "OnBecameVisible", "OnBecameInvisible",
        "OnParticleCollision", "OnParticleTrigger", "OnParticleSystemStopped",
        "OnAnimatorIK", "OnAnimatorMove",
        "OnRenderObject", "OnPostRender", "OnPreRender", "OnPreCull", "OnWillRenderObject", "OnRenderImage",
        "OnDrawGizmos", "OnDrawGizmosSelected",
        "OnApplicationFocus", "OnApplicationPause", "OnApplicationQuit",
        "OnAudioFilterRead", "OnJointBreak", "OnJointBreak2D", "OnControllerColliderHit",
        "OnTransformChildrenChanged", "OnTransformParentChanged",
        "OnRectTransformDimensionsChange", "OnBeforeTransformParentChanged",
        "OnDidApplyAnimationProperties", "OnCanvasGroupChanged", "OnCanvasHierarchyChanged",
        "OnStateEnter", "OnStateUpdate", "OnStateExit", "OnStateMove", "OnStateIK",
        "OnStateMachineEnter", "OnStateMachineExit",
        "OnInspectorGUI", "CreateInspectorGUI", "OnSceneGUI", "HasPreviewGUI",
        "OnPreviewGUI", "OnInteractivePreviewGUI", "RequiresConstantRepaint",
        "OnGUI", "GetPropertyHeight", "CreatePropertyGUI",
        "CreateGUI", "OnSelectionChange", "OnFocus", "OnLostFocus", "OnHierarchyChange", "OnProjectChange",
        "OnPreprocessTexture", "OnPostprocessTexture", "OnPreprocessModel", "OnPostprocessModel",
        "OnPreprocessAudio", "OnPostprocessAudio", "OnPreprocessAsset", "OnPostprocessAllAssets",
        "OnImportAsset",
        "OnNetworkSpawn", "OnNetworkDespawn", "OnGainedOwnership", "OnLostOwnership",
    };

    public override ImmutableArray<SuppressionDescriptor> SupportedSuppressions { get; } = ImmutableArray.Create(
        DiagnosticIds.SuppressCS0649Rule,
        DiagnosticIds.SuppressCS0169Rule,
        DiagnosticIds.SuppressIDE0051Rule);

    public override void ReportSuppressions(SuppressionAnalysisContext context)
    {
        foreach (var diagnostic in context.ReportedDiagnostics)
        {
            var descriptor = diagnostic.Id switch
            {
                "CS0649" => DiagnosticIds.SuppressCS0649Rule,
                "CS0169" => DiagnosticIds.SuppressCS0169Rule,
                "IDE0051" => DiagnosticIds.SuppressIDE0051Rule,
                _ => null,
            };
            if (descriptor == null) continue;

            var tree = diagnostic.Location.SourceTree;
            if (tree == null) continue;

            var root = tree.GetRoot(context.CancellationToken);
            var node = root.FindNode(diagnostic.Location.SourceSpan, getInnermostNodeForTie: true);
            var semanticModel = context.GetSemanticModel(tree);
            var symbol = ResolveDeclaredSymbol(node, semanticModel, context.CancellationToken);
            if (symbol == null) continue;

            if (ShouldSuppressSymbol(symbol, diagnostic.Id))
            {
                context.ReportSuppression(Suppression.Create(descriptor, diagnostic));
            }
        }
    }

    private static ISymbol? ResolveDeclaredSymbol(
        SyntaxNode node,
        SemanticModel model,
        System.Threading.CancellationToken ct)
    {
        var direct = model.GetDeclaredSymbol(node, ct);
        if (direct != null) return direct;

        var declarator = node.FirstAncestorOrSelf<VariableDeclaratorSyntax>();
        if (declarator != null)
        {
            return model.GetDeclaredSymbol(declarator, ct);
        }

        var method = node.FirstAncestorOrSelf<MethodDeclarationSyntax>();
        if (method != null)
        {
            return model.GetDeclaredSymbol(method, ct);
        }

        return null;
    }

    private static bool ShouldSuppressSymbol(ISymbol symbol, string diagnosticId)
    {
        if (symbol is IFieldSymbol field)
        {
            if (field.ContainingType == null) return false;
            bool isUnityOrSerializableContainer =
                UnityCallGraphHelper.DerivesFromUnityBehaviour(field.ContainingType) ||
                HasAttribute(field.ContainingType, "System.Serializable");
            if (!isUnityOrSerializableContainer) return false;

            return HasAttribute(field, "UnityEngine.SerializeField") ||
                   HasAttribute(field, "UnityEngine.SerializeReference") ||
                   field.DeclaredAccessibility == Accessibility.Public;
        }

        if (symbol is IMethodSymbol method && diagnosticId == "IDE0051")
        {
            if (HasAttribute(method, "UnityEngine.RuntimeInitializeOnLoadMethod") ||
                HasAttribute(method, "UnityEditor.InitializeOnLoadMethod") ||
                HasAttribute(method, "UnityEditor.MenuItem") ||
                HasAttribute(method, "UnityEngine.ContextMenu"))
            {
                return true;
            }

            if (method.ContainingType != null &&
                UnityCallGraphHelper.DerivesFromUnityBehaviour(method.ContainingType) &&
                UnityEventMethodNames.Contains(method.Name))
            {
                return true;
            }
        }

        return false;
    }

    private static bool HasAttribute(ISymbol symbol, string metadataBaseName)
    {
        string withAttr = metadataBaseName.EndsWith("Attribute", StringComparison.Ordinal)
            ? metadataBaseName
            : metadataBaseName + "Attribute";
        string shortNoAttr = metadataBaseName.Contains('.')
            ? metadataBaseName[(metadataBaseName.LastIndexOf('.') + 1)..]
            : metadataBaseName;
        string shortWithAttr = shortNoAttr.EndsWith("Attribute", StringComparison.Ordinal)
            ? shortNoAttr
            : shortNoAttr + "Attribute";

        foreach (var attr in symbol.GetAttributes())
        {
            var cls = attr.AttributeClass;
            if (cls == null) continue;
            var fullName = cls.ToDisplayString();
            if (string.Equals(fullName, metadataBaseName, StringComparison.Ordinal) ||
                string.Equals(fullName, withAttr, StringComparison.Ordinal) ||
                string.Equals(cls.Name, shortNoAttr, StringComparison.Ordinal) ||
                string.Equals(cls.Name, shortWithAttr, StringComparison.Ordinal))
            {
                return true;
            }
        }
        return false;
    }
}
