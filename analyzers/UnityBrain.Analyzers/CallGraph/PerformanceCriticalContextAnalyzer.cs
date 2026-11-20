using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace UnityBrain.Analyzers.CallGraph;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class PerformanceCriticalContextAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(DiagnosticIds.UB1001Rule, DiagnosticIds.UB1002Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();

        context.RegisterCompilationStartAction(startCtx =>
        {
            var roots = UnityCallGraphHelper.LoadPerformanceCriticalRootNames(
                startCtx.Options.AdditionalFiles);

            startCtx.RegisterSymbolAction(symbolCtx =>
            {
                if (symbolCtx.Symbol is not INamedTypeSymbol typeSymbol ||
                    typeSymbol.TypeKind != TypeKind.Class ||
                    !UnityCallGraphHelper.DerivesFromUnityBehaviour(typeSymbol))
                {
                    return;
                }

                var criticalMap = UnityCallGraphHelper.BuildCriticalMethodMap(
                    typeSymbol,
                    symbolCtx.Compilation,
                    roots);

                if (criticalMap.Count == 0) return;

                foreach (var entry in criticalMap.Values)
                {
                    AnalyzeCriticalMethod(symbolCtx, entry, symbolCtx.Compilation);
                }
            }, SymbolKind.NamedType);
        });
    }

    private static void AnalyzeCriticalMethod(
        SymbolAnalysisContext symbolCtx,
        CriticalMethodInfo info,
        Compilation compilation)
    {
        foreach (var syntaxRef in info.Method.DeclaringSyntaxReferences)
        {
            var methodSyntax = syntaxRef.GetSyntax(symbolCtx.CancellationToken);
            var model = compilation.GetSemanticModel(methodSyntax.SyntaxTree);

            // 1. Invocations: GetComponent / TryGetComponent / Find* / Resources.Load*
            foreach (var inv in methodSyntax.DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (model.GetSymbolInfo(inv, symbolCtx.CancellationToken).Symbol is not IMethodSymbol called)
                {
                    continue;
                }

                if (IsCacheableGetComponent(called, inv))
                {
                    symbolCtx.ReportDiagnostic(Diagnostic.Create(
                        DiagnosticIds.UB1002Rule,
                        inv.GetLocation(),
                        called.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
                        info.CallChain));

                    if (!info.IsRoot)
                    {
                        symbolCtx.ReportDiagnostic(Diagnostic.Create(
                            DiagnosticIds.UB1001Rule,
                            inv.GetLocation(),
                            called.Name,
                            info.CallChain));
                    }
                    continue;
                }

                if ((!info.IsRoot && IsGetOrTryGetComponent(called)) || IsExpensiveUnityLookup(called))
                {
                    symbolCtx.ReportDiagnostic(Diagnostic.Create(
                        DiagnosticIds.UB1001Rule,
                        inv.GetLocation(),
                        IsGetOrTryGetComponent(called) ? called.Name : $"{called.ContainingType.Name}.{called.Name}",
                        info.CallChain));
                }
            }

            // 2. Member access: Camera.main in critical method or indirect helper
            foreach (var memberAccess in methodSyntax.DescendantNodes().OfType<MemberAccessExpressionSyntax>())
            {
                if (model.GetSymbolInfo(memberAccess, symbolCtx.CancellationToken).Symbol is IPropertySymbol prop &&
                    prop.Name == "main" &&
                    prop.ContainingType.ToDisplayString() == "UnityEngine.Camera")
                {
                    symbolCtx.ReportDiagnostic(Diagnostic.Create(
                        DiagnosticIds.UB1001Rule,
                        memberAccess.GetLocation(),
                        "Camera.main",
                        info.CallChain));
                }
            }

            // 3. Allocation: new WaitForSeconds(...)
            foreach (var objCreation in methodSyntax.DescendantNodes().OfType<ObjectCreationExpressionSyntax>())
            {
                var typeInfo = model.GetTypeInfo(objCreation, symbolCtx.CancellationToken).Type;
                if (typeInfo?.ToDisplayString() == "UnityEngine.WaitForSeconds")
                {
                    symbolCtx.ReportDiagnostic(Diagnostic.Create(
                        DiagnosticIds.UB1001Rule,
                        objCreation.GetLocation(),
                        "new WaitForSeconds",
                        info.CallChain));
                }
            }
        }
    }

    private static bool IsCacheableGetComponent(IMethodSymbol method, InvocationExpressionSyntax inv)
    {
        if (method.Name == "TryGetComponent" || !IsGetOrTryGetComponent(method))
        {
            return false;
        }

        // Only GetComponent*() targeting `this`, `this.gameObject`, `this.transform`, `gameObject`, or `transform`
        // can be safely cached in `this.Awake()`; external receivers like `other.GetComponent<T>()` cannot.
        if (inv.Expression is GenericNameSyntax || inv.Expression is IdentifierNameSyntax)
        {
            return true;
        }

        if (inv.Expression is MemberAccessExpressionSyntax ma)
        {
            if (ma.Expression is ThisExpressionSyntax)
            {
                return true;
            }
            if (ma.Expression is IdentifierNameSyntax id &&
                (id.Identifier.Text == "gameObject" || id.Identifier.Text == "transform"))
            {
                return true;
            }
            if (ma.Expression is MemberAccessExpressionSyntax inner &&
                inner.Expression is ThisExpressionSyntax &&
                (inner.Name.Identifier.Text == "gameObject" || inner.Name.Identifier.Text == "transform"))
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsGetOrTryGetComponent(IMethodSymbol method)
    {
        if (method.Name != "GetComponent" &&
            method.Name != "GetComponentInChildren" &&
            method.Name != "GetComponentInParent" &&
            method.Name != "GetComponents" &&
            method.Name != "GetComponentsInChildren" &&
            method.Name != "GetComponentsInParent" &&
            method.Name != "TryGetComponent")
        {
            return false;
        }
        var ns = method.ContainingNamespace?.ToDisplayString() ?? string.Empty;
        return ns.StartsWith("UnityEngine", StringComparison.Ordinal);
    }

    private static bool IsExpensiveUnityLookup(IMethodSymbol method)
    {
        var containing = method.ContainingType.ToDisplayString();
        if (containing == "UnityEngine.GameObject" &&
            (method.Name == "Find" || method.Name == "FindWithTag" || method.Name == "FindGameObjectsWithTag"))
        {
            return true;
        }
        if (containing == "UnityEngine.Object" &&
            (method.Name.StartsWith("FindObjectOfType", StringComparison.Ordinal) ||
             method.Name.StartsWith("FindObjectsOfType", StringComparison.Ordinal) ||
             method.Name.StartsWith("FindAnyObjectByType", StringComparison.Ordinal) ||
             method.Name.StartsWith("FindFirstObjectByType", StringComparison.Ordinal) ||
             method.Name.StartsWith("FindObjectsByType", StringComparison.Ordinal)))
        {
            return true;
        }
        if (containing == "UnityEngine.Resources" &&
            method.Name.StartsWith("Load", StringComparison.Ordinal))
        {
            return true;
        }
        return false;
    }
}
