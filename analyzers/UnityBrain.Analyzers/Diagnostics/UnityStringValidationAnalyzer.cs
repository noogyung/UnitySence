using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Threading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using UnityBrain.Analyzers.Json;

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
        "StopCoroutine",
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
            var settings = LoadProjectSettings(startCtx.Options.AdditionalFiles, startCtx.CancellationToken);

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
        if (CallGraph.UnityCallGraphHelper.IsPackageCachePath(context.Node.SyntaxTree.FilePath)) return;
        var inv = (InvocationExpressionSyntax)context.Node;
        if (context.SemanticModel.GetSymbolInfo(inv, context.CancellationToken).Symbol is not IMethodSymbol called)
        {
            return;
        }

        string containingType = called.ContainingType.ToDisplayString();

        // 1. UB3001: MonoBehaviour.Invoke / InvokeRepeating / CancelInvoke / IsInvoking / StartCoroutine / StopCoroutine
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
                    "태그",
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
                        "레이어",
                        lit.Token.ValueText));
                }
            }
            return;
        }

        // 3. UB3003: SceneManager.LoadScene / LoadSceneAsync / GetSceneByName
        if (containingType == "UnityEngine.SceneManagement.SceneManager" &&
            (called.Name == "LoadScene" || called.Name == "LoadSceneAsync" || called.Name == "GetSceneByName") &&
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
        if (CallGraph.UnityCallGraphHelper.IsPackageCachePath(context.Node.SyntaxTree.FilePath)) return;
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
                "태그",
                lit.Token.ValueText));
        }
    }

    private static void AnalyzeEquality(SyntaxNodeAnalysisContext context, ProjectSettingsSnapshot settings)
    {
        if (CallGraph.UnityCallGraphHelper.IsPackageCachePath(context.Node.SyntaxTree.FilePath)) return;
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
                "태그",
                lit.Token.ValueText));
        }
    }

    private static bool IsUnityTagProperty(SemanticModel model, ExpressionSyntax expr, CancellationToken ct)
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
            if (ma.Expression is BaseExpressionSyntax)
            {
                targetType = context.SemanticModel.GetEnclosingSymbol(inv.SpanStart, context.CancellationToken)?.ContainingType;
            }
            else
            {
                targetType = context.SemanticModel.GetTypeInfo(ma.Expression, context.CancellationToken).Type as INamedTypeSymbol;
                // Avoid false positives when calling Invoke/StartCoroutine on a base-typed `MonoBehaviour` parameter/field.
                if (targetType != null && targetType.ToDisplayString() == "UnityEngine.MonoBehaviour")
                {
                    return;
                }
            }
        }
        targetType ??= context.SemanticModel.GetEnclosingSymbol(inv.SpanStart, context.CancellationToken)?.ContainingType;
        if (targetType == null) return;

        bool isCoroutine = apiName == "StartCoroutine" || apiName == "StopCoroutine";
        var allMembers = new List<IMethodSymbol>();
        var validCandidates = new List<IMethodSymbol>();
        for (var cur = targetType; cur != null; cur = cur.BaseType)
        {
            foreach (var member in cur.GetMembers(targetMethodName).OfType<IMethodSymbol>())
            {
                if (member.MethodKind != MethodKind.Ordinary || member.IsStatic || member.Arity != 0)
                {
                    continue;
                }
                allMembers.Add(member);
                if (isCoroutine)
                {
                    if (member.Parameters.Length <= 1)
                    {
                        validCandidates.Add(member);
                    }
                }
                else
                {
                    if (member.Parameters.Length == 0)
                    {
                        validCandidates.Add(member);
                    }
                }
            }
        }

        if (validCandidates.Count == 0)
        {
            context.ReportDiagnostic(Diagnostic.Create(
                DiagnosticIds.UB3001Rule,
                lit.GetLocation(),
                $"[UnitySense] '{targetType.Name}' 클래스(또는 부모 클래스)에 {apiName} 대상 메서드 '{targetMethodName}'가 존재하지 않습니다."));
            return;
        }

        if (apiName == "StartCoroutine")
        {
            bool hasEnumeratorReturn = validCandidates.Any(m => IsSystemCollectionsIEnumerator(m.ReturnType));

            if (!hasEnumeratorReturn)
            {
                context.ReportDiagnostic(Diagnostic.Create(
                    DiagnosticIds.UB3001Rule,
                    lit.GetLocation(),
                    $"[UnitySense] StartCoroutine 대상 메서드 '{targetMethodName}'('{targetType.Name}')는 반드시 IEnumerator를 반환해야 합니다."));
            }
        }
    }

    private static bool IsSystemCollectionsIEnumerator(ITypeSymbol returnType)
    {
        var full = returnType.ToDisplayString();
        if (full == "System.Collections.IEnumerator")
        {
            return true;
        }
        foreach (var iface in returnType.AllInterfaces)
        {
            if (iface.ToDisplayString() == "System.Collections.IEnumerator")
            {
                return true;
            }
        }
        return false;
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

    private static readonly string[] BuiltinUnityTags =
    {
        "Untagged",
        "Respawn",
        "Finish",
        "EditorOnly",
        "MainCamera",
        "Player",
        "GameController",
    };

    private static readonly string[] BuiltinUnityLayers =
    {
        "Default",
        "TransparentFX",
        "Ignore Raycast",
        "Water",
        "UI",
    };

    private static string StripYamlQuotes(string raw)
    {
        var trimmed = raw.Trim();
        if (trimmed.Length >= 2 &&
            ((trimmed[0] == '"' && trimmed[trimmed.Length - 1] == '"') ||
             (trimmed[0] == '\'' && trimmed[trimmed.Length - 1] == '\'')))
        {
            return trimmed.Substring(1, trimmed.Length - 2);
        }
        return trimmed;
    }

    private static void ParseTagManagerAsset(
        string yaml,
        HashSet<string> tags,
        HashSet<string> layers,
        ref bool hasTags,
        ref bool hasLayers)
    {
        var section = "none";
        var lines = yaml.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
        foreach (var rawLine in lines)
        {
            var trimmed = rawLine.Trim();
            if (string.IsNullOrEmpty(trimmed) || trimmed.StartsWith("%", StringComparison.Ordinal) || trimmed.StartsWith("---", StringComparison.Ordinal))
            {
                continue;
            }

            int indent = 0;
            while (indent < rawLine.Length && rawLine[indent] == ' ') indent++;

            if (indent <= 2 && !trimmed.StartsWith("-", StringComparison.Ordinal))
            {
                if (trimmed == "tags:" || trimmed == "tags: []")
                {
                    hasTags = true;
                    foreach (var builtin in BuiltinUnityTags) tags.Add(builtin);
                    section = trimmed.EndsWith("[]", StringComparison.Ordinal) ? "none" : "tags";
                    continue;
                }
                if (trimmed == "layers:" || trimmed == "layers: []")
                {
                    hasLayers = true;
                    foreach (var builtin in BuiltinUnityLayers) layers.Add(builtin);
                    section = trimmed.EndsWith("[]", StringComparison.Ordinal) ? "none" : "layers";
                    continue;
                }
                if (trimmed.IndexOf(':') >= 0)
                {
                    section = "none";
                    continue;
                }
            }

            if (section == "tags" && trimmed.StartsWith("-", StringComparison.Ordinal))
            {
                var val = StripYamlQuotes(trimmed.Substring(1));
                if (!string.IsNullOrEmpty(val)) tags.Add(val);
            }
            else if (section == "layers" && trimmed.StartsWith("-", StringComparison.Ordinal))
            {
                var val = StripYamlQuotes(trimmed.Substring(1));
                if (!string.IsNullOrEmpty(val)) layers.Add(val);
            }
        }
    }

    private static void AddSceneVariants(HashSet<string> enabledScenes, string scenePath)
    {
        var norm = scenePath.Replace('\\', '/');
        enabledScenes.Add(norm);
        if (norm.EndsWith(".unity", StringComparison.OrdinalIgnoreCase))
        {
            enabledScenes.Add(norm.Substring(0, norm.Length - ".unity".Length));
        }
        if (norm.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase))
        {
            var sub = norm.Substring("Assets/".Length);
            enabledScenes.Add(sub);
            if (sub.EndsWith(".unity", StringComparison.OrdinalIgnoreCase))
            {
                enabledScenes.Add(sub.Substring(0, sub.Length - ".unity".Length));
            }
        }
        var fileNameNoExt = System.IO.Path.GetFileNameWithoutExtension(norm);
        if (!string.IsNullOrEmpty(fileNameNoExt))
        {
            enabledScenes.Add(fileNameNoExt);
        }
    }

    private static void ParseEditorBuildSettingsAsset(
        string yaml,
        HashSet<string> enabledScenes,
        ref bool hasBuildScenes)
    {
        bool inScenes = false;
        bool currentHasEntry = false;
        bool currentEnabled = false;
        string? currentPath = null;

        void Flush()
        {
            if (!currentHasEntry || !currentEnabled || string.IsNullOrEmpty(currentPath))
            {
                currentHasEntry = false;
                currentEnabled = false;
                currentPath = null;
                return;
            }

            AddSceneVariants(enabledScenes, currentPath!);

            currentHasEntry = false;
            currentEnabled = false;
            currentPath = null;
        }

        var lines = yaml.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
        foreach (var rawLine in lines)
        {
            var trimmed = rawLine.Trim();
            if (string.IsNullOrEmpty(trimmed) || trimmed.StartsWith("%", StringComparison.Ordinal) || trimmed.StartsWith("---", StringComparison.Ordinal))
            {
                continue;
            }

            int indent = 0;
            while (indent < rawLine.Length && rawLine[indent] == ' ') indent++;

            if (trimmed == "m_Scenes:" || trimmed == "m_Scenes: []")
            {
                Flush();
                hasBuildScenes = true;
                inScenes = !trimmed.EndsWith("[]", StringComparison.Ordinal);
                continue;
            }
            if (!inScenes) continue;

            if (indent <= 2 && !trimmed.StartsWith("-", StringComparison.Ordinal) && trimmed.IndexOf(':') >= 0)
            {
                Flush();
                inScenes = false;
                continue;
            }

            if (trimmed.StartsWith("- enabled:", StringComparison.Ordinal))
            {
                Flush();
                var val = trimmed.Substring("- enabled:".Length).Trim();
                currentHasEntry = true;
                currentEnabled = val == "1" || string.Equals(val, "true", StringComparison.OrdinalIgnoreCase);
                continue;
            }

            if (!currentHasEntry) continue;
            if (trimmed.StartsWith("path:", StringComparison.Ordinal))
            {
                currentPath = StripYamlQuotes(trimmed.Substring("path:".Length));
            }
        }
        Flush();
    }

    private static ProjectSettingsSnapshot LoadProjectSettings(
        ImmutableArray<AdditionalText> additionalFiles,
        CancellationToken cancellationToken = default)
    {
        bool hasAnyFile = false;
        bool hasTags = false;
        bool hasLayers = false;
        bool hasScenes = false;
        var tags = new HashSet<string>(StringComparer.Ordinal);
        var layers = new HashSet<string>(StringComparer.Ordinal);
        var enabledScenes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var file in additionalFiles)
        {
            if (file.Path.EndsWith("TagManager.asset", StringComparison.OrdinalIgnoreCase))
            {
                var yaml = file.GetText(cancellationToken)?.ToString();
                if (!string.IsNullOrWhiteSpace(yaml))
                {
                    hasAnyFile = true;
                    ParseTagManagerAsset(yaml!, tags, layers, ref hasTags, ref hasLayers);
                }
                continue;
            }

            if (file.Path.EndsWith("EditorBuildSettings.asset", StringComparison.OrdinalIgnoreCase))
            {
                var yaml = file.GetText(cancellationToken)?.ToString();
                if (!string.IsNullOrWhiteSpace(yaml))
                {
                    hasAnyFile = true;
                    ParseEditorBuildSettingsAsset(yaml!, enabledScenes, ref hasScenes);
                }
                continue;
            }

            if (!file.Path.EndsWith("project-settings.json", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var text = file.GetText(cancellationToken)?.ToString();
            if (string.IsNullOrWhiteSpace(text))
            {
                continue;
            }

            try
            {
                if (SimpleJson.Parse(text!) is not Dictionary<string, object?> root)
                {
                    continue;
                }
                hasAnyFile = true;

                if (root.TryGetValue("tags", out var tagsRaw) && tagsRaw is List<object?> tagsList)
                {
                    hasTags = true;
                    foreach (var el in tagsList)
                    {
                        if (el is string val && !string.IsNullOrEmpty(val))
                        {
                            tags.Add(val);
                        }
                    }
                }

                if (root.TryGetValue("layers", out var layersRaw) && layersRaw is List<object?> layersList)
                {
                    hasLayers = true;
                    foreach (var el in layersList)
                    {
                        if (el is string val && !string.IsNullOrEmpty(val))
                        {
                            layers.Add(val);
                        }
                        else if (el is Dictionary<string, object?> obj &&
                                 obj.TryGetValue("name", out var nameObj) &&
                                 nameObj is string nameStr &&
                                 !string.IsNullOrEmpty(nameStr))
                        {
                            layers.Add(nameStr);
                        }
                    }
                }

                object? scenesRaw = null;
                if ((root.TryGetValue("buildScenes", out scenesRaw) || root.TryGetValue("scenes", out scenesRaw)) &&
                    scenesRaw is List<object?> scenesList)
                {
                    hasScenes = true;
                    foreach (var el in scenesList)
                    {
                        if (el is string s && !string.IsNullOrEmpty(s))
                        {
                            AddSceneVariants(enabledScenes, s);
                            continue;
                        }

                        if (el is not Dictionary<string, object?> obj) continue;
                        bool enabled = !obj.TryGetValue("enabled", out var enVal) || enVal is true;
                        if (!enabled) continue;

                        if (obj.TryGetValue("name", out var nameVal) && nameVal is string nameStr && !string.IsNullOrEmpty(nameStr))
                        {
                            enabledScenes.Add(nameStr);
                        }

                        if (obj.TryGetValue("path", out var pathVal) && pathVal is string p && !string.IsNullOrEmpty(p))
                        {
                            AddSceneVariants(enabledScenes, p);
                        }
                    }
                }
            }
            catch
            {
                // Ignore malformed project-settings.json
            }
        }

        return new ProjectSettingsSnapshot(hasAnyFile, hasTags, hasLayers, hasScenes, tags, layers, enabledScenes);
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
