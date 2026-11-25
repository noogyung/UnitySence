using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Threading;
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
                startCtx.Options.AdditionalFiles,
                startCtx.CancellationToken);

            startCtx.RegisterSymbolAction(symbolCtx =>
            {
                if (symbolCtx.Symbol is not INamedTypeSymbol typeSymbol ||
                    typeSymbol.TypeKind != TypeKind.Class ||
                    UnityCallGraphHelper.IsPackageCacheSymbol(typeSymbol) ||
                    !UnityCallGraphHelper.DerivesFromUnityBehaviour(typeSymbol))
                {
                    return;
                }

                var criticalMap = UnityCallGraphHelper.BuildCriticalMethodMap(
                    typeSymbol,
                    symbolCtx.Compilation,
                    roots,
                    symbolCtx.CancellationToken);

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
        var ct = symbolCtx.CancellationToken;
        foreach (var syntaxRef in info.Method.DeclaringSyntaxReferences)
        {
            var methodSyntax = syntaxRef.GetSyntax(ct);
            if (methodSyntax is TypeDeclarationSyntax) continue;
            var model = compilation.GetSemanticModel(methodSyntax.SyntaxTree);

            foreach (var node in UnityCallGraphHelper.EnumerateDirectBodyNodes(methodSyntax))
            {
                if (node is InvocationExpressionSyntax inv)
                {
                    if (model.GetSymbolInfo(inv, ct).Symbol is not IMethodSymbol called)
                    {
                        continue;
                    }

                    if (IsCacheableGetComponent(called, inv, model, ct))
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
                else if (node is MemberAccessExpressionSyntax memberAccess)
                {
                    if (model.GetSymbolInfo(memberAccess, ct).Symbol is IPropertySymbol prop &&
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
                else if (node is BaseObjectCreationExpressionSyntax objCreation)
                {
                    var typeInfo = model.GetTypeInfo(objCreation, ct).Type;
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
    }

    private static bool IsCacheableGetComponent(
        IMethodSymbol method,
        InvocationExpressionSyntax inv,
        SemanticModel model,
        CancellationToken ct)
    {
        // Only single-component generic lookups (not GetComponents* array/list or TryGetComponent)
        // can be safely cached into a single `_field = GetComponent...<T>();` inside Awake().
        if (method.Name != "GetComponent" &&
            method.Name != "GetComponentInChildren" &&
            method.Name != "GetComponentInParent")
        {
            return false;
        }
        if (method.TypeArguments.Length != 1)
        {
            return false;
        }
        var ns = method.ContainingNamespace?.ToDisplayString() ?? string.Empty;
        if (!ns.StartsWith("UnityEngine", StringComparison.Ordinal))
        {
            return false;
        }

        // Arguments must be 0 or compile-time constants (never local variables out of Awake scope).
        foreach (var arg in inv.ArgumentList.Arguments)
        {
            if (!model.GetConstantValue(arg.Expression, ct).HasValue)
            {
                return false;
            }
        }

        if (inv.Expression is GenericNameSyntax || inv.Expression is IdentifierNameSyntax)
        {
            return true;
        }

        if (inv.Expression is MemberAccessExpressionSyntax ma)
        {
            if (IsUnitySelfComponentOrGameObject(ma.Expression, model, ct))
            {
                return true;
            }
        }

        return false;
    }

    private static ExpressionSyntax UnwrapParentheses(ExpressionSyntax expr)
    {
        while (expr is ParenthesizedExpressionSyntax paren)
        {
            expr = paren.Expression;
        }
        return expr;
    }

    private static bool IsUnitySelfComponentOrGameObject(
        ExpressionSyntax expr,
        SemanticModel model,
        CancellationToken ct)
    {
        expr = UnwrapParentheses(expr);
        if (expr is ThisExpressionSyntax)
        {
            return true;
        }

        bool isSelfReceiver = expr is IdentifierNameSyntax ||
            (expr is MemberAccessExpressionSyntax inner &&
             UnwrapParentheses(inner.Expression) is ThisExpressionSyntax);
        if (!isSelfReceiver)
        {
            return false;
        }

        if (model.GetSymbolInfo(expr, ct).Symbol is IPropertySymbol prop &&
            (prop.Name == "gameObject" || prop.Name == "transform"))
        {
            var owner = prop.ContainingType.ToDisplayString();
            return owner == "UnityEngine.Component" ||
                   owner == "UnityEngine.MonoBehaviour" ||
                   owner == "UnityEngine.Behaviour" ||
                   owner == "UnityEngine.GameObject";
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
            (method.Name == "Find" ||
             method.Name == "FindWithTag" ||
             method.Name == "FindGameObjectWithTag" ||
             method.Name == "FindGameObjectsWithTag"))
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
            (method.Name.StartsWith("Load", StringComparison.Ordinal) ||
             method.Name == "FindObjectsOfTypeAll"))
        {
            return true;
        }
        return false;
    }
}
