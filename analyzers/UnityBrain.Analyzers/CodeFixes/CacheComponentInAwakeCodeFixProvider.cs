using System;
using System.Collections.Immutable;
using System.Composition;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace UnityBrain.Analyzers.CodeFixes;

[ExportCodeFixProvider(LanguageNames.CSharp, Name = nameof(CacheComponentInAwakeCodeFixProvider)), Shared]
public sealed class CacheComponentInAwakeCodeFixProvider : CodeFixProvider
{
    public override ImmutableArray<string> FixableDiagnosticIds =>
        ImmutableArray.Create(DiagnosticIds.UncachedComponentLookup);

    public override FixAllProvider GetFixAllProvider() => WellKnownFixAllProviders.BatchFixer;

    public override async Task RegisterCodeFixesAsync(CodeFixContext context)
    {
        var root = await context.Document.GetSyntaxRootAsync(context.CancellationToken).ConfigureAwait(false);
        if (root == null) return;

        var diag = context.Diagnostics[0];
        var node = root.FindNode(diag.Location.SourceSpan, getInnermostNodeForTie: true);
        var invocation = node.FirstAncestorOrSelf<InvocationExpressionSyntax>();
        if (invocation == null) return;

        var typeArg = ExtractGenericTypeArgument(invocation);
        if (typeArg == null) return;

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
        if (root == null) return document;

        var classDecl = invocation.FirstAncestorOrSelf<ClassDeclarationSyntax>();
        if (classDecl == null) return document;

        var fieldName = GenerateUniqueFieldName(classDecl, typeArg.ToString());
        var fieldIdentifier = SyntaxFactory.IdentifierName(fieldName);

        // 1. Track invocation and replace GetComponent<T>() with _cachedField
        var newClassDecl = classDecl.ReplaceNode(
            invocation,
            fieldIdentifier.WithTriviaFrom(invocation));

        // 2. Build field declaration: private T _fieldName;
        var fieldDecl = SyntaxFactory.FieldDeclaration(
            SyntaxFactory.VariableDeclaration(
                typeArg.WithoutTrivia(),
                SyntaxFactory.SingletonSeparatedList(
                    SyntaxFactory.VariableDeclarator(SyntaxFactory.Identifier(fieldName)))))
            .WithModifiers(SyntaxFactory.TokenList(SyntaxFactory.Token(SyntaxKind.PrivateKeyword)))
            .WithAdditionalAnnotations(Microsoft.CodeAnalysis.Formatting.Formatter.Annotation);

        // 3. Insert assignment into existing Awake() or create a new Awake()
        var assignStmt = SyntaxFactory.ParseStatement($"{fieldName} = {invocation.WithoutTrivia().ToFullString()};\n")
            .WithAdditionalAnnotations(Microsoft.CodeAnalysis.Formatting.Formatter.Annotation);

        var existingAwake = newClassDecl.Members
            .OfType<MethodDeclarationSyntax>()
            .FirstOrDefault(m => m.Identifier.ValueText == "Awake" && m.Body != null);

        if (existingAwake != null && existingAwake.Body != null)
        {
            var updatedBody = existingAwake.Body.WithStatements(
                existingAwake.Body.Statements.Insert(0, assignStmt));
            newClassDecl = newClassDecl.ReplaceNode(existingAwake, existingAwake.WithBody(updatedBody));
            newClassDecl = newClassDecl.WithMembers(newClassDecl.Members.Insert(0, fieldDecl));
        }
        else
        {
            var awakeMethod = SyntaxFactory.MethodDeclaration(
                SyntaxFactory.PredefinedType(SyntaxFactory.Token(SyntaxKind.VoidKeyword)),
                SyntaxFactory.Identifier("Awake"))
                .WithModifiers(SyntaxFactory.TokenList(SyntaxFactory.Token(SyntaxKind.PrivateKeyword)))
                .WithBody(SyntaxFactory.Block(assignStmt))
                .WithAdditionalAnnotations(Microsoft.CodeAnalysis.Formatting.Formatter.Annotation);

            newClassDecl = newClassDecl.WithMembers(
                newClassDecl.Members.Insert(0, awakeMethod).Insert(0, fieldDecl));
        }

        var updatedRoot = root.ReplaceNode(classDecl, newClassDecl);
        var formatted = Microsoft.CodeAnalysis.Formatting.Formatter.Format(
            updatedRoot,
            document.Project.Solution.Workspace,
            cancellationToken: ct);
        return document.WithSyntaxRoot(formatted);
    }

    private static string GenerateUniqueFieldName(ClassDeclarationSyntax classDecl, string typeName)
    {
        var shortName = typeName.Contains('.') ? typeName.Substring(typeName.LastIndexOf('.') + 1) : typeName;
        var cleanBase = "_" + char.ToLowerInvariant(shortName[0]) + shortName.Substring(1);

        var existing = classDecl.Members
            .OfType<FieldDeclarationSyntax>()
            .SelectMany(f => f.Declaration.Variables)
            .Select(v => v.Identifier.ValueText)
            .ToHashSet(StringComparer.Ordinal);

        if (!existing.Contains(cleanBase)) return cleanBase;
        for (int i = 2; i < 100; i++)
        {
            var cand = $"{cleanBase}{i}";
            if (!existing.Contains(cand)) return cand;
        }
        return cleanBase + "_cached";
    }
}
