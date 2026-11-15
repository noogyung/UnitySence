using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Composition;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Formatting;
using UnityBrain.Analyzers.Diagnostics;

namespace UnityBrain.Analyzers.CodeFixes;

[ExportCodeFixProvider(LanguageNames.CSharp, Name = nameof(ExtractPropertyToIdCodeFixProvider)), Shared]
public sealed class ExtractPropertyToIdCodeFixProvider : CodeFixProvider
{
    public override ImmutableArray<string> FixableDiagnosticIds =>
        ImmutableArray.Create(DiagnosticIds.UncachedShaderOrAnimatorPropertyId);

    public override FixAllProvider GetFixAllProvider() => WellKnownFixAllProviders.BatchFixer;

    public override async Task RegisterCodeFixesAsync(CodeFixContext context)
    {
        var root = await context.Document.GetSyntaxRootAsync(context.CancellationToken).ConfigureAwait(false);
        if (root == null) return;

        var diag = context.Diagnostics[0];
        var node = root.FindNode(diag.Location.SourceSpan, getInnermostNodeForTie: true);
        if (node is not LiteralExpressionSyntax literal ||
            !literal.IsKind(SyntaxKind.StringLiteralExpression))
        {
            return;
        }

        diag.Properties.TryGetValue(UncachedShaderOrAnimatorIdAnalyzer.PropertyKindKey, out var kind);
        diag.Properties.TryGetValue(UncachedShaderOrAnimatorIdAnalyzer.HashMethodKey, out var hashMethod);
        kind ??= "Shader";
        hashMethod ??= kind == "Animator" ? "Animator.StringToHash" : "Shader.PropertyToID";

        var propertyName = literal.Token.ValueText;
        context.RegisterCodeFix(
            CodeAction.Create(
                title: $"Extract \"{propertyName}\" to static readonly int ({hashMethod})",
                createChangedDocument: ct => ExtractToStaticFieldAsync(context.Document, literal, kind, propertyName, ct),
                equivalenceKey: nameof(ExtractPropertyToIdCodeFixProvider)),
            diag);
    }

    private static async Task<Document> ExtractToStaticFieldAsync(
        Document document,
        LiteralExpressionSyntax targetLiteral,
        string kind,
        string propertyName,
        CancellationToken ct)
    {
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var semanticModel = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (root == null) return document;

        var typeDecl = targetLiteral.FirstAncestorOrSelf<TypeDeclarationSyntax>();
        if (typeDecl == null) return document;

        string targetHashMethodName = kind == "Animator" ? "StringToHash" : "PropertyToID";
        string? existingFieldName = FindExistingCachedFieldName(typeDecl, targetHashMethodName, propertyName);
        string fieldName = existingFieldName ?? GenerateUniqueFieldName(typeDecl, propertyName, kind);

        var matchingLiterals = FindMatchingLiteralsInType(
            typeDecl,
            targetLiteral,
            semanticModel,
            kind,
            propertyName,
            ct);

        var newTypeDecl = typeDecl.ReplaceNodes(
            matchingLiterals,
            (orig, _) => SyntaxFactory.IdentifierName(fieldName).WithTriviaFrom(orig));

        if (existingFieldName == null)
        {
            bool hasUnityEngineUsing = HasUnityEngineUsing(root);
            string hashCallTarget = kind == "Animator"
                ? (hasUnityEngineUsing ? "Animator.StringToHash" : "UnityEngine.Animator.StringToHash")
                : (hasUnityEngineUsing ? "Shader.PropertyToID" : "UnityEngine.Shader.PropertyToID");

            string quotedName = SymbolDisplay.FormatLiteral(propertyName, quote: true);
            var fieldDecl = SyntaxFactory.ParseMemberDeclaration(
                $"private static readonly int {fieldName} = {hashCallTarget}({quotedName});\n")!
                .WithAdditionalAnnotations(Formatter.Annotation);

            int insertIdx = 0;
            for (int i = 0; i < newTypeDecl.Members.Count; i++)
            {
                if (newTypeDecl.Members[i] is FieldDeclarationSyntax)
                {
                    insertIdx = i + 1;
                }
                else
                {
                    break;
                }
            }

            newTypeDecl = newTypeDecl.WithMembers(newTypeDecl.Members.Insert(insertIdx, fieldDecl));
        }

        var newRoot = root.ReplaceNode(typeDecl, newTypeDecl);
        return document.WithSyntaxRoot(newRoot);
    }

    private static List<LiteralExpressionSyntax> FindMatchingLiteralsInType(
        TypeDeclarationSyntax typeDecl,
        LiteralExpressionSyntax targetLiteral,
        SemanticModel? model,
        string kind,
        string propertyName,
        CancellationToken ct)
    {
        var matches = new List<LiteralExpressionSyntax> { targetLiteral };
        if (model == null) return matches;

        foreach (var inv in typeDecl.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            if (model.GetSymbolInfo(inv, ct).Symbol is not IMethodSymbol called)
            {
                continue;
            }
            if (!UncachedShaderOrAnimatorIdAnalyzer.TryClassifyCall(called, out var callKind, out _) ||
                callKind != kind)
            {
                continue;
            }

            var lit = UncachedShaderOrAnimatorIdAnalyzer.TryGetStringLiteralArgument(inv, called);
            if (lit != null &&
                lit != targetLiteral &&
                lit.Token.ValueText == propertyName)
            {
                matches.Add(lit);
            }
        }

        return matches;
    }

    private static string? FindExistingCachedFieldName(
        TypeDeclarationSyntax typeDecl,
        string hashMethodName,
        string propertyName)
    {
        foreach (var field in typeDecl.Members.OfType<FieldDeclarationSyntax>())
        {
            foreach (var v in field.Declaration.Variables)
            {
                if (v.Initializer?.Value is InvocationExpressionSyntax inv &&
                    inv.ArgumentList.Arguments.Count == 1 &&
                    inv.ArgumentList.Arguments[0].Expression is LiteralExpressionSyntax lit &&
                    lit.IsKind(SyntaxKind.StringLiteralExpression) &&
                    lit.Token.ValueText == propertyName)
                {
                    var calleeText = inv.Expression.ToString();
                    if (calleeText.EndsWith(hashMethodName, StringComparison.Ordinal))
                    {
                        return v.Identifier.ValueText;
                    }
                }
            }
        }
        return null;
    }

    private static bool HasUnityEngineUsing(SyntaxNode root)
    {
        if (root is CompilationUnitSyntax cu)
        {
            if (cu.Usings.Any(u => u.Name?.ToString() == "UnityEngine"))
            {
                return true;
            }
        }
        return false;
    }

    private static string GenerateUniqueFieldName(
        TypeDeclarationSyntax typeDecl,
        string rawName,
        string kind)
    {
        var sb = new StringBuilder();
        bool upperNext = true;
        foreach (char ch in rawName)
        {
            if (!char.IsLetterOrDigit(ch))
            {
                upperNext = true;
                continue;
            }
            sb.Append(upperNext ? char.ToUpperInvariant(ch) : ch);
            upperNext = false;
        }

        string baseName = sb.Length > 0 ? sb.ToString() : "Property";
        if (char.IsDigit(baseName[0]))
        {
            baseName = "_" + baseName;
        }

        string suffix = kind == "Animator" ? "Hash" : "Id";
        if (!baseName.EndsWith(suffix, StringComparison.Ordinal))
        {
            baseName += suffix;
        }

        var existingNames = typeDecl.Members
            .OfType<FieldDeclarationSyntax>()
            .SelectMany(f => f.Declaration.Variables.Select(v => v.Identifier.ValueText))
            .Concat(typeDecl.Members.OfType<PropertyDeclarationSyntax>().Select(p => p.Identifier.ValueText))
            .ToHashSet(StringComparer.Ordinal);

        string candidate = baseName;
        int n = 2;
        while (existingNames.Contains(candidate))
        {
            candidate = $"{baseName}{n}";
            n++;
        }

        return candidate;
    }
}
