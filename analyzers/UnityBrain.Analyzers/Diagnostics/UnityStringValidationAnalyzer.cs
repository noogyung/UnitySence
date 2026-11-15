using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace UnityBrain.Analyzers.Diagnostics;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class UnityStringValidationAnalyzer : DiagnosticAnalyzer
{
    private static readonly HashSet<string> InvokeOrCoroutineMethods = new(StringComparer.Ordinal)
    {
        "Invoke",
        "InvokeRepeating",
        "CancelInvoke",
        "IsInvoking",
        "StartCoroutine",
    };

    private static readonly HashSet<string> TagLookupMethods = new(StringComparer.Ordinal)
    {
        "CompareTag",
        "FindWithTag",
        "FindGameObjectWithTag",
        "FindGameObjectsWithTag",
    };

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(
            DiagnosticIds.UB3001Rule,
            DiagnosticIds.UB3002Rule,
            DiagnosticIds.UB3003Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();

        context.RegisterCompilationStartAction(startCtx =>
        {
            var settings = LoadProjectSettings(startCtx.Options.AdditionalFiles);

            startCtx.RegisterSyntaxNodeAction(
                nodeCtx => AnalyzeInvocation(nodeCtx, settings),
                SyntaxKind.InvocationExpression);

            startCtx.RegisterSyntaxNodeAction(
                nodeCtx => AnalyzeAssignment(nodeCtx, settings),
                SyntaxKind.SimpleAssignmentExpression);

            startCtx.RegisterSyntaxNodeAction(
                nodeCtx => AnalyzeEquality(nodeCtx, settings),
                SyntaxKind.EqualsExpression,
                SyntaxKind.NotEqualsExpression);
        });
    }

    private static void AnalyzeInvocation(SyntaxNodeAnalysisContext context, ProjectSettingsSnapshot settings)
    {
        var inv = (InvocationExpressionSyntax)context.Node;
        if (context.SemanticModel.GetSymbolInfo(inv, context.CancellationToken).Symbol is not IMethodSymbol called)
        {
            return;
        }

        string containingType = called.ContainingType.ToDisplayString();

        // 1. UB3001: MonoBehaviour.Invoke / InvokeRepeating / CancelInvoke / IsInvoking / StartCoroutine
        if (containingType == "UnityEngine.MonoBehaviour" &&
            InvokeOrCoroutineMethods.Contains(called.Name) &&
            called.Parameters.Length > 0 &&
            called.Parameters[0].Type.SpecialType == SpecialType.System_String)
        {
            var lit = UncachedShaderOrAnimatorIdAnalyzer.TryGetStringLiteralArgument(inv, called);
            if (lit != null)
            {
                ValidateInvokeOrCoroutineTarget(context, inv, called.Name, lit);
            }
            return;
        }

        if (!settings.HasFile)
        {
            return;
        }

        // 2. UB3002: Tag & Layer lookups
        if ((containingType == "UnityEngine.GameObject" || containingType == "UnityEngine.Component") &&
            TagLookupMethods.Contains(called.Name) &&
            called.Parameters.Length > 0 &&
            called.Parameters[0].Type.SpecialType == SpecialType.System_String &&
            settings.HasTags)
        {
            var lit = UncachedShaderOrAnimatorIdAnalyzer.TryGetStringLiteralArgument(inv, called);
            if (lit != null && !settings.Tags.Contains(lit.Token.ValueText))
            {
                context.ReportDiagnostic(Diagnostic.Create(
                    DiagnosticIds.UB3002Rule,
                    lit.GetLocation(),
                    "Tag",
                    lit.Token.ValueText));
            }
            return;
        }

        if (containingType == "UnityEngine.LayerMask" &&
            (called.Name == "NameToLayer" || called.Name == "GetMask") &&
            settings.HasLayers)
        {
            foreach (var arg in inv.ArgumentList.Arguments)
            {
                if (arg.Expression is LiteralExpressionSyntax lit &&
                    lit.IsKind(SyntaxKind.StringLiteralExpression) &&
                    !settings.Layers.Contains(lit.Token.ValueText))
                {
                    context.ReportDiagnostic(Diagnostic.Create(
                        DiagnosticIds.UB3002Rule,
                        lit.GetLocation(),
                        "Layer",
                        lit.Token.ValueText));
                }
            }
            return;
        }

        // 3. UB3003: SceneManager.LoadScene / LoadSceneAsync
        if (containingType == "UnityEngine.SceneManagement.SceneManager" &&
            (called.Name == "LoadScene" || called.Name == "LoadSceneAsync") &&
            called.Parameters.Length > 0 &&
            called.Parameters[0].Type.SpecialType == SpecialType.System_String &&
            settings.HasBuildScenes)
        {
            var lit = UncachedShaderOrAnimatorIdAnalyzer.TryGetStringLiteralArgument(inv, called);
            if (lit != null && !IsEnabledScene(settings, lit.Token.ValueText))
            {
                context.ReportDiagnostic(Diagnostic.Create(
                    DiagnosticIds.UB3003Rule,
                    lit.GetLocation(),
                    lit.Token.ValueText));
            }
        }
    }

    private static void AnalyzeAssignment(SyntaxNodeAnalysisContext context, ProjectSettingsSnapshot settings)
    {
        if (!settings.HasFile || !settings.HasTags) return;

        var assign = (AssignmentExpressionSyntax)context.Node;
        if (assign.Right is not LiteralExpressionSyntax lit ||
            !lit.IsKind(SyntaxKind.StringLiteralExpression))
        {
            return;
        }

        if (IsUnityTagProperty(context.SemanticModel, assign.Left, context.CancellationToken) &&
            !settings.Tags.Contains(lit.Token.ValueText))
        {
            context.ReportDiagnostic(Diagnostic.Create(
                DiagnosticIds.UB3002Rule,
                lit.GetLocation(),
                "Tag",
                lit.Token.ValueText));
        }
    }

    private static void AnalyzeEquality(SyntaxNodeAnalysisContext context, ProjectSettingsSnapshot settings)
    {
        if (!settings.HasFile || !settings.HasTags) return;

        var bin = (BinaryExpressionSyntax)context.Node;
        LiteralExpressionSyntax? lit = null;
        ExpressionSyntax? other = null;

        if (bin.Right is LiteralExpressionSyntax rightLit &&
            rightLit.IsKind(SyntaxKind.StringLiteralExpression))
        {
            lit = rightLit;
            other = bin.Left;
        }
        else if (bin.Left is LiteralExpressionSyntax leftLit &&
                 leftLit.IsKind(SyntaxKind.StringLiteralExpression))
        {
            lit = leftLit;
            other = bin.Right;
        }

        if (lit != null &&
            other != null &&
            IsUnityTagProperty(context.SemanticModel, other, context.CancellationToken) &&
            !settings.Tags.Contains(lit.Token.ValueText))
        {
            context.ReportDiagnostic(Diagnostic.Create(
                DiagnosticIds.UB3002Rule,
                lit.GetLocation(),
                "Tag",
                lit.Token.ValueText));
        }
    }

    private static bool IsUnityTagProperty(SemanticModel model, ExpressionSyntax expr, System.Threading.CancellationToken ct)
    {
        if (model.GetSymbolInfo(expr, ct).Symbol is not IPropertySymbol prop ||
            prop.Name != "tag")
        {
            return false;
        }

        var owner = prop.ContainingType.ToDisplayString();
        return owner == "UnityEngine.GameObject" || owner == "UnityEngine.Component";
    }

    private static void ValidateInvokeOrCoroutineTarget(
        SyntaxNodeAnalysisContext context,
        InvocationExpressionSyntax inv,
        string apiName,
        LiteralExpressionSyntax lit)
    {
        string targetMethodName = lit.Token.ValueText;
        INamedTypeSymbol? targetType = null;

        if (inv.Expression is MemberAccessExpressionSyntax ma)
        {
            targetType = context.SemanticModel.GetTypeInfo(ma.Expression, context.CancellationToken).Type as INamedTypeSymbol;
        }
        targetType ??= context.SemanticModel.GetEnclosingSymbol(inv.SpanStart, context.CancellationToken)?.ContainingType;
        if (targetType == null) return;

        var matchingMethods = new List<IMethodSymbol>();
        for (var cur = targetType; cur != null; cur = cur.BaseType)
        {
            foreach (var member in cur.GetMembers(targetMethodName).OfType<IMethodSymbol>())
            {
                matchingMethods.Add(member);
            }
        }

        if (matchingMethods.Count == 0)
        {
            context.ReportDiagnostic(Diagnostic.Create(
                DiagnosticIds.UB3001Rule,
                lit.GetLocation(),
                $"Method '{targetMethodName}' called via {apiName} does not exist on '{targetType.Name}' or its base types"));
            return;
        }

        if (apiName == "StartCoroutine")
        {
            bool hasEnumeratorReturn = matchingMethods.Any(m =>
                m.ReturnType.ToDisplayString() == "System.Collections.IEnumerator" ||
                m.ReturnType.Name == "IEnumerator");

            if (!hasEnumeratorReturn)
            {
                context.ReportDiagnostic(Diagnostic.Create(
                    DiagnosticIds.UB3001Rule,
                    lit.GetLocation(),
                    $"StartCoroutine target '{targetMethodName}' on '{targetType.Name}' must return System.Collections.IEnumerator"));
            }
        }
    }

    private static bool IsEnabledScene(ProjectSettingsSnapshot settings, string sceneArg)
    {
        var normalized = sceneArg.Replace('\\', '/');
        if (settings.EnabledScenes.Contains(normalized))
        {
            return true;
        }
        if (normalized.EndsWith(".unity", StringComparison.OrdinalIgnoreCase))
        {
            var withoutExt = normalized.Substring(0, normalized.Length - ".unity".Length);
            if (settings.EnabledScenes.Contains(withoutExt))
            {
                return true;
            }
        }
        return false;
    }

    private static ProjectSettingsSnapshot LoadProjectSettings(ImmutableArray<AdditionalText> additionalFiles)
    {
        foreach (var file in additionalFiles)
        {
            if (!file.Path.EndsWith("project-settings.json", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var text = file.GetText()?.ToString();
            if (string.IsNullOrWhiteSpace(text))
            {
                continue;
            }

            try
            {
                using var doc = JsonDocument.Parse(text);
                var root = doc.RootElement;
                var tags = new HashSet<string>(StringComparer.Ordinal);
                var layers = new HashSet<string>(StringComparer.Ordinal);
                var enabledScenes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

                bool hasTags = root.TryGetProperty("tags", out var tagsEl) && tagsEl.ValueKind == JsonValueKind.Array;
                if (hasTags)
                {
                    foreach (var el in tagsEl.EnumerateArray())
                    {
                        var val = el.GetString();
                        if (!string.IsNullOrEmpty(val)) tags.Add(val!);
                    }
                }

                bool hasLayers = root.TryGetProperty("layers", out var layersEl) && layersEl.ValueKind == JsonValueKind.Array;
                if (hasLayers)
                {
                    foreach (var el in layersEl.EnumerateArray())
                    {
                        if (el.ValueKind == JsonValueKind.String)
                        {
                            var val = el.GetString();
                            if (!string.IsNullOrEmpty(val)) layers.Add(val!);
                        }
                        else if (el.ValueKind == JsonValueKind.Object &&
                                 el.TryGetProperty("name", out var nameEl))
                        {
                            var val = nameEl.GetString();
                            if (!string.IsNullOrEmpty(val)) layers.Add(val!);
                        }
                    }
                }

                bool hasScenes = (root.TryGetProperty("buildScenes", out var scenesEl) ||
                                  root.TryGetProperty("scenes", out scenesEl)) &&
                                 scenesEl.ValueKind == JsonValueKind.Array;
                if (hasScenes)
                {
                    foreach (var el in scenesEl.EnumerateArray())
                    {
                        if (el.ValueKind == JsonValueKind.String)
                        {
                            var s = el.GetString();
                            if (!string.IsNullOrEmpty(s)) enabledScenes.Add(s!.Replace('\\', '/'));
                            continue;
                        }

                        if (el.ValueKind != JsonValueKind.Object) continue;
                        bool enabled = !el.TryGetProperty("enabled", out var enEl) || enEl.ValueKind == JsonValueKind.True;
                        if (!enabled) continue;

                        if (el.TryGetProperty("name", out var nameEl))
                        {
                            var name = nameEl.GetString();
                            if (!string.IsNullOrEmpty(name)) enabledScenes.Add(name!);
                        }

                        if (el.TryGetProperty("path", out var pathEl))
                        {
                            var p = pathEl.GetString()?.Replace('\\', '/');
                            if (!string.IsNullOrEmpty(p))
                            {
                                enabledScenes.Add(p!);
                                if (p!.EndsWith(".unity", StringComparison.OrdinalIgnoreCase))
                                {
                                    enabledScenes.Add(p.Substring(0, p.Length - ".unity".Length));
                                }
                            }
                        }
                    }
                }

                return new ProjectSettingsSnapshot(true, hasTags, hasLayers, hasScenes, tags, layers, enabledScenes);
            }
            catch
            {
                // Ignore malformed project-settings.json
            }
        }

        return new ProjectSettingsSnapshot(
            false,
            false,
            false,
            false,
            new HashSet<string>(),
            new HashSet<string>(),
            new HashSet<string>());
    }

    private sealed record ProjectSettingsSnapshot(
        bool HasFile,
        bool HasTags,
        bool HasLayers,
        bool HasBuildScenes,
        HashSet<string> Tags,
        HashSet<string> Layers,
        HashSet<string> EnabledScenes);
}
