using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Threading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace UnityBrain.Analyzers.Diagnostics;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class BurstCompileAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(
            DiagnosticIds.UB2001Rule,
            DiagnosticIds.UB2002Rule,
            DiagnosticIds.UB2003Rule,
            DiagnosticIds.UB2004Rule);

    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
        context.EnableConcurrentExecution();

        context.RegisterSymbolAction(AnalyzeNamedType, SymbolKind.NamedType);
    }

    private static void AnalyzeNamedType(SymbolAnalysisContext context)
    {
        if (context.Symbol is not INamedTypeSymbol typeSymbol ||
            (typeSymbol.TypeKind != TypeKind.Class && typeSymbol.TypeKind != TypeKind.Struct))
        {
            return;
        }

        if (CallGraph.UnityCallGraphHelper.IsPackageCacheSymbol(typeSymbol))
        {
            return;
        }

        bool typeHasBurst = HasAttribute(typeSymbol, "BurstCompileAttribute", "BurstCompile");
        // In Unity Burst, [BurstCompile] on a class (e.g. static class or MonoBehaviour) is only a
        // marker container for `[BurstCompile] static` methods; instance fields and non-Burst methods
        // on classes remain managed C#. Only structs inherit Burst compilation across all members.
        bool isBurstStruct = typeSymbol.TypeKind == TypeKind.Struct && typeHasBurst;

        if (isBurstStruct)
        {
            foreach (var field in typeSymbol.GetMembers().OfType<IFieldSymbol>())
            {
                if (field.IsImplicitlyDeclared || field.IsStatic || field.IsConst)
                {
                    continue;
                }
                if (field.Type.IsReferenceType)
                {
                    var loc = field.Locations.FirstOrDefault() ?? typeSymbol.Locations.FirstOrDefault();
                    if (loc != null)
                    {
                        context.ReportDiagnostic(Diagnostic.Create(
                            DiagnosticIds.UB2001Rule,
                            loc,
                            field.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)));
                    }
                }
            }
        }

        foreach (var method in typeSymbol.GetMembers().OfType<IMethodSymbol>())
        {
            if (method.IsImplicitlyDeclared) continue;
            if (HasAttribute(method, "BurstDiscardAttribute", "BurstDiscard")) continue;

            bool methodExplicitBurst = HasAttribute(method, "BurstCompileAttribute", "BurstCompile");
            bool methodHasBurst = isBurstStruct ||
                                  (methodExplicitBurst && (typeSymbol.TypeKind != TypeKind.Class || method.IsStatic));
            if (!methodHasBurst) continue;

            AnalyzeBurstMethodSignature(context, method);

            foreach (var syntaxRef in method.DeclaringSyntaxReferences)
            {
                var methodSyntax = syntaxRef.GetSyntax(context.CancellationToken);
                if (methodSyntax is TypeDeclarationSyntax) continue;

                var model = context.Compilation.GetSemanticModel(methodSyntax.SyntaxTree);
                var op = model.GetOperation(methodSyntax, context.CancellationToken);

                if (op != null)
                {
                    AnalyzeOperationTree(context, op, context.CancellationToken);
                }
                else
                {
                    AnalyzeMethodSyntaxExceptionsFallback(context, methodSyntax, model, context.CancellationToken);
                }
            }
        }
    }

    private static void AnalyzeBurstMethodSignature(SymbolAnalysisContext context, IMethodSymbol method)
    {
        if (!method.ReturnsVoid)
        {
            if (method.ReturnType.SpecialType == SpecialType.System_String)
            {
                var loc = method.Locations.FirstOrDefault();
                if (loc != null)
                {
                    context.ReportDiagnostic(Diagnostic.Create(
                        DiagnosticIds.UB2003Rule,
                        loc,
                        "managed string return type"));
                }
            }
            else if (method.ReturnType.IsReferenceType && method.ReturnType.TypeKind != TypeKind.TypeParameter)
            {
                var loc = method.Locations.FirstOrDefault();
                if (loc != null)
                {
                    context.ReportDiagnostic(Diagnostic.Create(
                        DiagnosticIds.UB2001Rule,
                        loc,
                        method.ReturnType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)));
                }
            }
        }

        foreach (var param in method.Parameters)
        {
            if (param.Type.SpecialType == SpecialType.System_String)
            {
                var loc = param.Locations.FirstOrDefault();
                if (loc != null)
                {
                    context.ReportDiagnostic(Diagnostic.Create(
                        DiagnosticIds.UB2003Rule,
                        loc,
                        "managed string parameter"));
                }
            }
            else if (param.Type.IsReferenceType && param.Type.TypeKind != TypeKind.TypeParameter)
            {
                var loc = param.Locations.FirstOrDefault();
                if (loc != null)
                {
                    context.ReportDiagnostic(Diagnostic.Create(
                        DiagnosticIds.UB2001Rule,
                        loc,
                        param.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)));
                }
            }
        }
    }

    private static void AnalyzeMethodSyntaxExceptionsFallback(
        SymbolAnalysisContext context,
        SyntaxNode methodSyntax,
        SemanticModel model,
        CancellationToken ct)
    {
        foreach (var tryStmt in methodSyntax.DescendantNodes().OfType<TryStatementSyntax>())
        {
            if (IsSyntaxInsideBurstDiscard(tryStmt, model, ct)) continue;
            if (tryStmt.Catches.Count > 0)
            {
                context.ReportDiagnostic(Diagnostic.Create(
                    DiagnosticIds.UB2004Rule,
                    tryStmt.TryKeyword.GetLocation(),
                    "try/catch"));
            }
        }

        foreach (var throwStmt in methodSyntax.DescendantNodes().OfType<ThrowStatementSyntax>())
        {
            if (IsSyntaxInsideBurstDiscard(throwStmt, model, ct)) continue;
            context.ReportDiagnostic(Diagnostic.Create(
                DiagnosticIds.UB2004Rule,
                throwStmt.ThrowKeyword.GetLocation(),
                "throw"));
        }

        foreach (var throwExpr in methodSyntax.DescendantNodes().OfType<ThrowExpressionSyntax>())
        {
            if (IsSyntaxInsideBurstDiscard(throwExpr, model, ct)) continue;
            context.ReportDiagnostic(Diagnostic.Create(
                DiagnosticIds.UB2004Rule,
                throwExpr.ThrowKeyword.GetLocation(),
                "throw"));
        }
    }

    private static bool IsSyntaxInsideBurstDiscard(SyntaxNode node, SemanticModel model, CancellationToken ct)
    {
        for (var cur = node.Parent; cur != null; cur = cur.Parent)
        {
            if (cur is LocalFunctionStatementSyntax localFn)
            {
                var sym = model.GetDeclaredSymbol(localFn, ct);
                if (HasAttribute(sym, "BurstDiscardAttribute", "BurstDiscard"))
                {
                    return true;
                }
            }
            else if (cur is InvocationExpressionSyntax inv &&
                     model.GetSymbolInfo(inv, ct).Symbol is IMethodSymbol target &&
                     HasAttribute(target, "BurstDiscardAttribute", "BurstDiscard"))
            {
                return true;
            }
        }
        return false;
    }

    private static void AnalyzeOperationTree(SymbolAnalysisContext context, IOperation rootOp, CancellationToken ct)
    {
        foreach (var op in rootOp.DescendantsAndSelf())
        {
            ct.ThrowIfCancellationRequested();
            if (IsInsideBurstDiscardCall(op))
            {
                continue;
            }

            switch (op)
            {
                case IObjectCreationOperation objCreate:
                    if (objCreate.Type != null && objCreate.Type.IsReferenceType)
                    {
                        context.ReportDiagnostic(Diagnostic.Create(
                            DiagnosticIds.UB2001Rule,
                            objCreate.Syntax.GetLocation(),
                            objCreate.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)));
                    }
                    break;

                case IAnonymousObjectCreationOperation anonCreate:
                    context.ReportDiagnostic(Diagnostic.Create(
                        DiagnosticIds.UB2001Rule,
                        anonCreate.Syntax.GetLocation(),
                        "anonymous type"));
                    break;

                case IDelegateCreationOperation delCreate:
                    context.ReportDiagnostic(Diagnostic.Create(
                        DiagnosticIds.UB2001Rule,
                        delCreate.Syntax.GetLocation(),
                        delCreate.Type?.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) ?? "delegate"));
                    break;

                case IArrayCreationOperation arrCreate:
                    context.ReportDiagnostic(Diagnostic.Create(
                        DiagnosticIds.UB2001Rule,
                        arrCreate.Syntax.GetLocation(),
                        arrCreate.Type?.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat) ?? "T[]"));
                    break;

                case IVariableDeclaratorOperation varDecl:
                    var varType = varDecl.Symbol.Type;
                    if (varType.IsReferenceType &&
                        varType.SpecialType != SpecialType.System_String &&
                        varType.TypeKind != TypeKind.TypeParameter &&
                        varDecl.Initializer?.Value is not IObjectCreationOperation &&
                        varDecl.Initializer?.Value is not IArrayCreationOperation &&
                        varDecl.Initializer?.Value is not IAnonymousObjectCreationOperation &&
                        varDecl.Initializer?.Value is not IDelegateCreationOperation &&
                        !(varDecl.Initializer?.Value is IConversionOperation convInit && IsForbiddenBoxing(convInit)))
                    {
                        context.ReportDiagnostic(Diagnostic.Create(
                            DiagnosticIds.UB2001Rule,
                            varDecl.Syntax.GetLocation(),
                            varType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)));
                    }
                    break;

                case IConversionOperation conv:
                    if (IsForbiddenBoxing(conv))
                    {
                        context.ReportDiagnostic(Diagnostic.Create(
                            DiagnosticIds.UB2002Rule,
                            conv.Syntax.GetLocation(),
                            conv.Operand.Type!.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
                            conv.Type!.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)));
                    }
                    break;

                case ITryOperation tryOp:
                    if (tryOp.Catches.Length > 0)
                    {
                        var loc = tryOp.Syntax is TryStatementSyntax ts
                            ? ts.TryKeyword.GetLocation()
                            : tryOp.Syntax.GetLocation();
                        context.ReportDiagnostic(Diagnostic.Create(
                            DiagnosticIds.UB2004Rule,
                            loc,
                            "try/catch"));
                    }
                    break;

                case IThrowOperation throwOp:
                {
                    var loc = throwOp.Syntax switch
                    {
                        ThrowStatementSyntax ts => ts.ThrowKeyword.GetLocation(),
                        ThrowExpressionSyntax te => te.ThrowKeyword.GetLocation(),
                        _ => throwOp.Syntax.GetLocation(),
                    };
                    context.ReportDiagnostic(Diagnostic.Create(
                        DiagnosticIds.UB2004Rule,
                        loc,
                        "throw"));
                    break;
                }

                case IInterpolatedStringOperation interp:
                    context.ReportDiagnostic(Diagnostic.Create(
                        DiagnosticIds.UB2003Rule,
                        interp.Syntax.GetLocation(),
                        "string interpolation"));
                    break;

                case IBinaryOperation bin:
                    if (bin.OperatorKind == BinaryOperatorKind.Add &&
                        bin.Type?.SpecialType == SpecialType.System_String &&
                        !(bin.Parent is IBinaryOperation parentBin &&
                          parentBin.OperatorKind == BinaryOperatorKind.Add &&
                          parentBin.Type?.SpecialType == SpecialType.System_String))
                    {
                        context.ReportDiagnostic(Diagnostic.Create(
                            DiagnosticIds.UB2003Rule,
                            bin.Syntax.GetLocation(),
                            "string concatenation"));
                    }
                    break;

                case IInvocationOperation inv:
                    AnalyzeBurstInvocation(context, inv);
                    break;
            }
        }
    }

    private static void AnalyzeBurstInvocation(SymbolAnalysisContext context, IInvocationOperation inv)
    {
        var method = inv.TargetMethod;
        if (method.ContainingType.SpecialType == SpecialType.System_String &&
            (method.Name == "Format" || method.Name == "Concat" || method.Name == "Join"))
        {
            context.ReportDiagnostic(Diagnostic.Create(
                DiagnosticIds.UB2003Rule,
                inv.Syntax.GetLocation(),
                $"string.{method.Name}"));
            return;
        }

        if (method.Name == "ToString" &&
            method.ReturnType.SpecialType == SpecialType.System_String)
        {
            context.ReportDiagnostic(Diagnostic.Create(
                DiagnosticIds.UB2003Rule,
                inv.Syntax.GetLocation(),
                $"{method.ContainingType.Name}.ToString"));
        }
    }

    private static bool IsForbiddenBoxing(IConversionOperation conv)
    {
        var src = conv.Operand.Type;
        var dst = conv.Type;
        if (src == null || dst == null) return false;
        if (!src.IsValueType || dst.IsValueType) return false;

        var dstFull = dst.ToDisplayString();
        return dst.SpecialType == SpecialType.System_Object ||
               dst.TypeKind == TypeKind.Interface ||
               dstFull == "System.ValueType" ||
               dstFull == "System.Enum";
    }

    private static bool IsInsideBurstDiscardCall(IOperation op)
    {
        for (var cur = op; cur != null; cur = cur.Parent)
        {
            if (cur is IInvocationOperation inv &&
                HasAttribute(inv.TargetMethod, "BurstDiscardAttribute", "BurstDiscard"))
            {
                return true;
            }
            if (cur is ILocalFunctionOperation localFn &&
                HasAttribute(localFn.Symbol, "BurstDiscardAttribute", "BurstDiscard"))
            {
                return true;
            }
        }
        return false;
    }

    private static bool HasAttribute(ISymbol? symbol, string fullShortName, string shortName)
    {
        if (symbol == null) return false;
        foreach (var attr in symbol.GetAttributes())
        {
            var name = attr.AttributeClass?.Name;
            if (name == fullShortName || name == shortName)
            {
                return true;
            }
        }
        return false;
    }
}
