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

namespace UnityBrain.Analyzers.CodeFixes;

[ExportCodeFixProvider(LanguageNames.CSharp, Name = nameof(CacheComponentInAwakeCodeFixProvider)), Shared]
public sealed class CacheComponentInAwakeCodeFixProvider : CodeFixProvider
{
    public override ImmutableArray<string> FixableDiagnosticIds =>
        ImmutableArray.Create(DiagnosticIds.UncachedComponentLookup);

    public override FixAllProvider GetFixAllProvider() => WellKnownFixAllProviders.BatchFixer;

    public override async Task RegisterCodeFixesAsync(CodeFixContext context)
    {
        if (context.Diagnostics.IsEmpty) return;

        var root = await context.Document.GetSyntaxRootAsync(context.CancellationToken).ConfigureAwait(false);
        if (root == null) return;

        var diag = context.Diagnostics[0];
        var node = root.FindNode(diag.Location.SourceSpan, getInnermostNodeForTie: true);
        var invocation = node.FirstAncestorOrSelf<InvocationExpressionSyntax>();
        if (invocation == null) return;

        var typeArg = ExtractGenericTypeArgument(invocation);
        if (typeArg == null || string.IsNullOrWhiteSpace(typeArg.ToString())) return;

        context.RegisterCodeFix(
            CodeAction.Create(
                title: $"[UnityBrain] Awake()에서 {typeArg} 컴포넌트 캐싱하기",
                createChangedDocument: ct => CacheComponentAsync(context.Document, invocation, typeArg, ct),
                equivalenceKey: nameof(CacheComponentInAwakeCodeFixProvider)),
            diag);
    }

    private static TypeSyntax? ExtractGenericTypeArgument(InvocationExpressionSyntax invocation)
    {
        if (invocation.Expression is GenericNameSyntax g1 && g1.TypeArgumentList.Arguments.Count == 1)
        {
            return g1.TypeArgumentList.Arguments[0];
        }
        if (invocation.Expression is MemberAccessExpressionSyntax ma &&
            ma.Name is GenericNameSyntax g2 &&
            g2.TypeArgumentList.Arguments.Count == 1)
        {
            return g2.TypeArgumentList.Arguments[0];
        }
        return null;
    }

    private static async Task<Document> CacheComponentAsync(
        Document document,
        InvocationExpressionSyntax invocation,
        TypeSyntax typeArg,
        CancellationToken ct)
    {
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var semanticModel = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (root == null) return document;

        var classDecl = invocation.FirstAncestorOrSelf<ClassDeclarationSyntax>();
        if (classDecl == null) return document;

        var classSymbol = semanticModel?.GetDeclaredSymbol(classDecl, ct);
        var enclosingMethod = invocation.FirstAncestorOrSelf<MethodDeclarationSyntax>();
        var fieldName = GenerateUniqueFieldName(classDecl, classSymbol, enclosingMethod, typeArg);
        var fieldIdentifier = SyntaxFactory.IdentifierName(fieldName);

        var newClassDecl = classDecl.ReplaceNode(
            invocation,
            fieldIdentifier.WithTriviaFrom(invocation));

        var fieldDecl = SyntaxFactory.FieldDeclaration(
            SyntaxFactory.VariableDeclaration(
                typeArg.WithoutTrivia(),
                SyntaxFactory.SingletonSeparatedList(
                    SyntaxFactory.VariableDeclarator(SyntaxFactory.Identifier(fieldName)))))
            .WithModifiers(SyntaxFactory.TokenList(SyntaxFactory.Token(SyntaxKind.PrivateKeyword)))
            .WithAdditionalAnnotations(Formatter.Annotation);

        var assignStmt = SyntaxFactory.ParseStatement($"{fieldName} = {invocation.WithoutTrivia().ToFullString()};")
            .WithAdditionalAnnotations(Formatter.Annotation);

        var existingAwake = newClassDecl.Members
            .OfType<MethodDeclarationSyntax>()
            .FirstOrDefault(m => m.Identifier.ValueText == "Awake" && m.ParameterList.Parameters.Count == 0);

        if (existingAwake != null)
        {
            if (existingAwake.Body != null)
            {
                var updatedBody = existingAwake.Body.WithStatements(
                    existingAwake.Body.Statements.Insert(0, assignStmt));
                newClassDecl = newClassDecl.ReplaceNode(existingAwake, existingAwake.WithBody(updatedBody));
                newClassDecl = newClassDecl.WithMembers(newClassDecl.Members.Insert(0, fieldDecl));
            }
            else if (existingAwake.ExpressionBody != null)
            {
                var exprStmt = SyntaxFactory.ExpressionStatement(existingAwake.ExpressionBody.Expression)
                    .WithAdditionalAnnotations(Formatter.Annotation);
                var convertedAwake = existingAwake
                    .WithExpressionBody(null)
                    .WithSemicolonToken(default)
                    .WithBody(SyntaxFactory.Block(assignStmt, exprStmt))
                    .WithAdditionalAnnotations(Formatter.Annotation);
                newClassDecl = newClassDecl.ReplaceNode(existingAwake, convertedAwake);
                newClassDecl = newClassDecl.WithMembers(newClassDecl.Members.Insert(0, fieldDecl));
            }
            else
            {
                newClassDecl = newClassDecl.WithMembers(newClassDecl.Members.Insert(0, fieldDecl));
            }
        }
        else
        {
            bool hasPartialAwake = classSymbol != null &&
                classSymbol.GetMembers("Awake").OfType<IMethodSymbol>().Any(m => m.Parameters.Length == 0);

            if (hasPartialAwake)
            {
                newClassDecl = newClassDecl.WithMembers(newClassDecl.Members.Insert(0, fieldDecl));
            }
            else
            {
                var awakeMethod = SyntaxFactory.MethodDeclaration(
                    SyntaxFactory.PredefinedType(SyntaxFactory.Token(SyntaxKind.VoidKeyword)),
                    SyntaxFactory.Identifier("Awake"))
                    .WithModifiers(SyntaxFactory.TokenList(SyntaxFactory.Token(SyntaxKind.PrivateKeyword)))
                    .WithBody(SyntaxFactory.Block(assignStmt))
                    .WithAdditionalAnnotations(Formatter.Annotation);

                newClassDecl = newClassDecl.WithMembers(
                    newClassDecl.Members.Insert(0, awakeMethod).Insert(0, fieldDecl));
            }
        }

        var updatedRoot = root.ReplaceNode(classDecl, newClassDecl);
        var updatedDoc = document.WithSyntaxRoot(updatedRoot);
        return await Formatter.FormatAsync(updatedDoc, Formatter.Annotation, cancellationToken: ct).ConfigureAwait(false);
    }

    private static string ExtractCleanTypeIdentifier(TypeSyntax typeArg)
    {
        switch (typeArg)
        {
            case QualifiedNameSyntax qn:
                return ExtractCleanTypeIdentifier(qn.Right);
            case AliasQualifiedNameSyntax aq:
                return ExtractCleanTypeIdentifier(aq.Name);
            case SimpleNameSyntax sn:
                return sn.Identifier.ValueText;
            default:
                var sb = new StringBuilder();
                foreach (var ch in typeArg.ToString())
                {
                    if (char.IsLetterOrDigit(ch) || ch == '_') sb.Append(ch);
                }
                return sb.ToString();
        }
    }

    private static string GenerateUniqueFieldName(
        ClassDeclarationSyntax classDecl,
        INamedTypeSymbol? classSymbol,
        MethodDeclarationSyntax? enclosingMethod,
        TypeSyntax typeArg)
    {
        var shortName = ExtractCleanTypeIdentifier(typeArg);
        if (string.IsNullOrEmpty(shortName))
        {
            shortName = "Component";
        }
        var cleanBase = "_" + char.ToLowerInvariant(shortName[0]) + shortName.Substring(1);

        var existing = new HashSet<string>(
            classDecl.Members
                .SelectMany(m => m switch
                {
                    FieldDeclarationSyntax f => f.Declaration.Variables.Select(v => v.Identifier.ValueText),
                    PropertyDeclarationSyntax p => new[] { p.Identifier.ValueText },
                    MethodDeclarationSyntax md => new[] { md.Identifier.ValueText },
                    _ => Array.Empty<string>(),
                }),
            StringComparer.Ordinal);

        for (var cur = classSymbol; cur != null; cur = cur.BaseType)
        {
            foreach (var m in cur.GetMembers())
            {
                existing.Add(m.Name);
            }
        }
        if (enclosingMethod != null)
        {
            foreach (var param in enclosingMethod.ParameterList.Parameters)
            {
                existing.Add(param.Identifier.ValueText);
            }
            foreach (var v in enclosingMethod.DescendantNodes().OfType<VariableDeclaratorSyntax>())
            {
                existing.Add(v.Identifier.ValueText);
            }
        }

        if (!existing.Contains(cleanBase)) return cleanBase;
        for (int i = 2; i < 100; i++)
        {
            var cand = $"{cleanBase}{i}";
            if (!existing.Contains(cand)) return cand;
        }
        return cleanBase + "_cached";
    }
}
