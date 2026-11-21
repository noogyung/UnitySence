using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using UnityBrain.Analyzers.CallGraph;

namespace UnityBrain.Analyzers.Diagnostics;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class UncachedShaderOrAnimatorIdAnalyzer : DiagnosticAnalyzer
{
    public const string PropertyKindKey = "Kind";
    public const string PropertyNameKey = "PropertyName";
    public const string HashMethodKey = "HashMethod";

    private static readonly HashSet<string> ExcludedShaderStringMethods = new(StringComparer.Ordinal)
    {
        "Find",
        "FindPass",
        "GetPassName",
        "EnableKeyword",
        "DisableKeyword",
        "IsKeywordEnabled",
        "GetTag",
        "SetOverrideTag",
        "SetShaderPassEnabled",
        "GetShaderPassEnabled",
        "SetKeyword",
    };

    private static readonly HashSet<string> AnimatorPropertyMethods = new(StringComparer.Ordinal)
    {
        "SetFloat",
        "SetBool",
        "SetInteger",
        "SetTrigger",
        "ResetTrigger",
        "GetFloat",
        "GetBool",
        "GetInteger",
        "IsParameterControlledByCurve",
        "Play",
        "CrossFade",
        "CrossFadeInFixedTime",
    };

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(DiagnosticIds.UB1003Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();

        context.RegisterCompilationStartAction(startCtx =>
        {
            var roots = UnityCallGraphHelper.LoadPerformanceCriticalRootNames(
                startCtx.Options.AdditionalFiles,
                startCtx.CancellationToken);

            startCtx.RegisterSymbolAction(symbolCtx =>
            {
                if (symbolCtx.Symbol is not INamedTypeSymbol typeSymbol ||
                    (typeSymbol.TypeKind != TypeKind.Class && typeSymbol.TypeKind != TypeKind.Struct))
                {
                    return;
                }

                Dictionary<IMethodSymbol, CriticalMethodInfo>? criticalMap = null;
                if (UnityCallGraphHelper.DerivesFromUnityBehaviour(typeSymbol))
                {
                    criticalMap = UnityCallGraphHelper.BuildCriticalMethodMap(
                        typeSymbol,
                        symbolCtx.Compilation,
                        roots,
                        symbolCtx.CancellationToken);
                }

                var candidates = new List<CandidateCall>();
                var counts = new Dictionary<(string Kind, string Literal), int>();

                foreach (var method in typeSymbol.GetMembers().OfType<IMethodSymbol>())
                {
                    if (method.IsImplicitlyDeclared) continue;
                    bool inCritical = criticalMap != null && criticalMap.ContainsKey(method);

                    foreach (var syntaxRef in method.DeclaringSyntaxReferences)
                    {
                        var methodSyntax = syntaxRef.GetSyntax(symbolCtx.CancellationToken);
                        if (methodSyntax is TypeDeclarationSyntax) continue;
                        var model = symbolCtx.Compilation.GetSemanticModel(methodSyntax.SyntaxTree);

                        foreach (var inv in UnityCallGraphHelper.EnumerateDirectBodyNodes(methodSyntax).OfType<InvocationExpressionSyntax>())
                        {
                            if (model.GetSymbolInfo(inv, symbolCtx.CancellationToken).Symbol is not IMethodSymbol called)
                            {
                                continue;
                            }

                            if (!TryClassifyCall(called, out var kind, out var hashMethod))
                            {
                                continue;
                            }

                            var stringArg = TryGetStringLiteralArgument(inv, called);
                            if (stringArg == null) continue;

                            var propName = stringArg.Token.ValueText;
                            if (string.IsNullOrEmpty(propName)) continue;

                            var key = (kind, propName);
                            counts[key] = counts.TryGetValue(key, out var c) ? c + 1 : 1;
                            candidates.Add(new CandidateCall(
                                stringArg,
                                kind,
                                propName,
                                hashMethod,
                                $"{called.ContainingType.Name}.{called.Name}",
                                inCritical));
                        }
                    }
                }

                foreach (var item in candidates)
                {
                    var key = (item.Kind, item.PropertyName);
                    int count = counts.TryGetValue(key, out var c) ? c : 0;
                    if (!item.InCriticalMethod && count < 2)
                    {
                        continue;
                    }

                    var props = ImmutableDictionary.CreateBuilder<string, string?>();
                    props.Add(PropertyKindKey, item.Kind);
                    props.Add(PropertyNameKey, item.PropertyName);
                    props.Add(HashMethodKey, item.HashMethod);

                    symbolCtx.ReportDiagnostic(Diagnostic.Create(
                        DiagnosticIds.UB1003Rule,
                        item.LiteralNode.GetLocation(),
                        props.ToImmutable(),
                        item.PropertyName,
                        item.ApiDisplay,
                        item.HashMethod));
                }
            }, SymbolKind.NamedType);
        });
    }

    internal static bool TryClassifyCall(IMethodSymbol called, out string kind, out string hashMethod)
    {
        kind = string.Empty;
        hashMethod = string.Empty;

        if (called.Parameters.Length == 0 ||
            called.Parameters[0].Type.SpecialType != SpecialType.System_String)
        {
            return false;
        }

        var containingType = called.ContainingType.ToDisplayString();
        var methodName = called.Name;

        if (containingType == "UnityEngine.Animator")
        {
            if (AnimatorPropertyMethods.Contains(methodName) && HasMatchingIntOverload(called))
            {
                kind = "Animator";
                hashMethod = "Animator.StringToHash";
                return true;
            }
            return false;
        }

        if (containingType == "UnityEngine.Material" ||
            containingType == "UnityEngine.Shader" ||
            containingType == "UnityEngine.MaterialPropertyBlock")
        {
            if (ExcludedShaderStringMethods.Contains(methodName))
            {
                return false;
            }

            if ((methodName.StartsWith("Has", StringComparison.Ordinal) ||
                 methodName.StartsWith("Set", StringComparison.Ordinal) ||
                 methodName.StartsWith("Get", StringComparison.Ordinal)) &&
                HasMatchingIntOverload(called))
            {
                kind = "Shader";
                hashMethod = "Shader.PropertyToID";
                return true;
            }
        }

        return false;
    }

    internal static bool HasMatchingIntOverload(IMethodSymbol called)
    {
        return FindMatchingIntOverload(called) != null;
    }

    internal static IMethodSymbol? FindMatchingIntOverload(IMethodSymbol called)
    {
        foreach (var candidate in called.ContainingType.GetMembers(called.Name).OfType<IMethodSymbol>())
        {
            if (candidate.IsStatic != called.IsStatic) continue;
            if (candidate.Parameters.Length != called.Parameters.Length) continue;
            if (candidate.Parameters[0].Type.SpecialType != SpecialType.System_Int32) continue;

            bool restMatch = true;
            for (int i = 1; i < candidate.Parameters.Length; i++)
            {
                if (!SymbolEqualityComparer.Default.Equals(candidate.Parameters[i].Type, called.Parameters[i].Type))
                {
                    restMatch = false;
                    break;
                }
            }
            if (restMatch)
            {
                return candidate;
            }
        }
        return null;
    }

    internal static LiteralExpressionSyntax? TryGetStringLiteralArgument(
        InvocationExpressionSyntax invocation,
        IMethodSymbol called)
    {
        if (invocation.ArgumentList.Arguments.Count == 0 || called.Parameters.Length == 0)
        {
            return null;
        }

        var firstParamName = called.Parameters[0].Name;
        var namedArg = invocation.ArgumentList.Arguments
            .FirstOrDefault(a => a.NameColon?.Name.Identifier.ValueText == firstParamName);
        var arg = namedArg ?? (invocation.ArgumentList.Arguments[0].NameColon == null
            ? invocation.ArgumentList.Arguments[0]
            : null);

        if (arg?.Expression is LiteralExpressionSyntax lit &&
            lit.IsKind(SyntaxKind.StringLiteralExpression))
        {
            return lit;
        }

        return null;
    }

    private sealed record CandidateCall(
        LiteralExpressionSyntax LiteralNode,
        string Kind,
        string PropertyName,
        string HashMethod,
        string ApiDisplay,
        bool InCriticalMethod);
}
