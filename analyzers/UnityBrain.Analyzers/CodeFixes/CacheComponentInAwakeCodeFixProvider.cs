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
        ImmutableArray.Create(
            DiagnosticIds.UncachedComponentLookup,
            DiagnosticIds.IndirectPerformanceCriticalInvocation);

    public override FixAllProvider GetFixAllProvider() => WellKnownFixAllProviders.BatchFixer;

    public override async Task RegisterCodeFixesAsync(CodeFixContext context)
    {
        if (context.Diagnostics.IsEmpty) return;

        var root = await context.Document.GetSyntaxRootAsync(context.CancellationToken).ConfigureAwait(false);
        if (root == null) return;

        SemanticModel? semanticModel = null;

        foreach (var diag in context.Diagnostics)
        {
            var node = root.FindNode(diag.Location.SourceSpan, getInnermostNodeForTie: true);

            if (diag.Id == DiagnosticIds.UncachedComponentLookup)
            {
                var invocation = node.FirstAncestorOrSelf<InvocationExpressionSyntax>();
                if (invocation == null) continue;

                var typeArg = ExtractGenericTypeArgument(invocation);
                if (typeArg == null || string.IsNullOrWhiteSpace(typeArg.ToString())) continue;

                var baseName = ExtractCleanTypeIdentifier(typeArg);
                if (string.IsNullOrEmpty(baseName))
                {
                    baseName = "Component";
                }

                var capturedInvocation = invocation;
                var capturedTypeArg = typeArg;

                context.RegisterCodeFix(
                    CodeAction.Create(
                        title: $"[UnityBrain] Awake()에서 {capturedTypeArg} 컴포넌트 캐싱하기",
                        createChangedDocument: ct => CacheExpressionInAwakeAsync(
                            context.Document,
                            capturedInvocation,
                            capturedTypeArg,
                            baseName,
                            ct),
                        equivalenceKey: nameof(CacheComponentInAwakeCodeFixProvider)),
                    diag);
            }
            else if (diag.Id == DiagnosticIds.IndirectPerformanceCriticalInvocation)
            {
                var memberAccess = node.FirstAncestorOrSelf<MemberAccessExpressionSyntax>();
                if (memberAccess == null || memberAccess.Name.Identifier.ValueText != "main")
                {
                    continue;
                }

                semanticModel ??= await context.Document.GetSemanticModelAsync(context.CancellationToken).ConfigureAwait(false);
                if (semanticModel == null) continue;

                if (semanticModel.GetSymbolInfo(memberAccess, context.CancellationToken).Symbol is not IPropertySymbol prop ||
                    prop.Name != "main" ||
                    prop.ContainingType.ToDisplayString() != "UnityEngine.Camera")
                {
                    continue;
                }

                var fieldType = ResolveCameraFieldType(root, memberAccess);
                var capturedMemberAccess = memberAccess;

                context.RegisterCodeFix(
                    CodeAction.Create(
                        title: "[UnityBrain] Awake()에서 Camera.main 캐싱하기",
                        createChangedDocument: ct => CacheExpressionInAwakeAsync(
                            context.Document,
                            capturedMemberAccess,
                            fieldType,
                            "mainCamera",
                            ct),
                        equivalenceKey: nameof(CacheComponentInAwakeCodeFixProvider) + ".CameraMain"),
                    diag);
            }
        }
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

    private static TypeSyntax ResolveCameraFieldType(SyntaxNode root, MemberAccessExpressionSyntax memberAccess)
    {
        bool usesQualifiedUnityEngineCamera = memberAccess.Expression is MemberAccessExpressionSyntax ma &&
            ma.Name.Identifier.ValueText == "Camera" &&
            (ma.Expression is IdentifierNameSyntax id && id.Identifier.ValueText == "UnityEngine" ||
             ma.Expression is AliasQualifiedNameSyntax aq &&
             aq.Alias.Identifier.ValueText == "global" &&
             aq.Name.Identifier.ValueText == "UnityEngine");

        if (usesQualifiedUnityEngineCamera)
        {
            bool hasUsingUnityEngine = root.DescendantNodes()
                .OfType<UsingDirectiveSyntax>()
                .Any(u => u.Alias == null &&
                          u.StaticKeyword.IsKind(SyntaxKind.None) &&
                          u.Name?.ToString() == "UnityEngine");
            if (!hasUsingUnityEngine)
            {
                return SyntaxFactory.ParseTypeName("UnityEngine.Camera");
            }
        }

        return SyntaxFactory.IdentifierName("Camera");
    }

    private static async Task<Document> CacheExpressionInAwakeAsync(
        Document document,
        ExpressionSyntax targetExpr,
        TypeSyntax fieldType,
        string preferredBaseName,
        CancellationToken ct)
    {
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var semanticModel = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (root == null) return document;

        var classDecl = targetExpr.FirstAncestorOrSelf<ClassDeclarationSyntax>();
        if (classDecl == null) return document;

        var existingAwake = classDecl.Members
            .OfType<MethodDeclarationSyntax>()
            .FirstOrDefault(m => m.Identifier.ValueText == "Awake" && m.ParameterList.Parameters.Count == 0);

        var existingCachedField = FindExistingCachedFieldName(classDecl, existingAwake, targetExpr);
        if (existingCachedField != null)
        {
            var reusedIdentifier = SyntaxFactory.IdentifierName(existingCachedField);
            var reusedClassDecl = classDecl.ReplaceNode(
                targetExpr,
                reusedIdentifier.WithTriviaFrom(targetExpr));
            var reusedRoot = root.ReplaceNode(classDecl, reusedClassDecl);
            var reusedDoc = document.WithSyntaxRoot(reusedRoot);
            return await Formatter.FormatAsync(reusedDoc, Formatter.Annotation, cancellationToken: ct).ConfigureAwait(false);
        }

        var classSymbol = semanticModel?.GetDeclaredSymbol(classDecl, ct);
        var enclosingMethod = targetExpr.FirstAncestorOrSelf<MethodDeclarationSyntax>();
        var fieldName = GenerateUniqueFieldName(classDecl, classSymbol, enclosingMethod, preferredBaseName);
        var fieldIdentifier = SyntaxFactory.IdentifierName(fieldName);

        var newClassDecl = classDecl.ReplaceNode(
            targetExpr,
            fieldIdentifier.WithTriviaFrom(targetExpr));

        var fieldDecl = SyntaxFactory.FieldDeclaration(
            SyntaxFactory.VariableDeclaration(
                fieldType.WithoutTrivia(),
                SyntaxFactory.SingletonSeparatedList(
                    SyntaxFactory.VariableDeclarator(SyntaxFactory.Identifier(fieldName)))))
            .WithModifiers(SyntaxFactory.TokenList(SyntaxFactory.Token(SyntaxKind.PrivateKeyword)))
            .WithAdditionalAnnotations(Formatter.Annotation);

        var assignStmt = SyntaxFactory.ParseStatement($"{fieldName} = {targetExpr.WithoutTrivia().ToFullString()};")
            .WithAdditionalAnnotations(Formatter.Annotation);

        var awakeInNewClass = newClassDecl.Members
            .OfType<MethodDeclarationSyntax>()
            .FirstOrDefault(m => m.Identifier.ValueText == "Awake" && m.ParameterList.Parameters.Count == 0);

        if (awakeInNewClass != null)
        {
            if (awakeInNewClass.Body != null)
            {
                var updatedBody = awakeInNewClass.Body.WithStatements(
                    awakeInNewClass.Body.Statements.Insert(0, assignStmt));
                newClassDecl = newClassDecl.ReplaceNode(awakeInNewClass, awakeInNewClass.WithBody(updatedBody));
                newClassDecl = newClassDecl.WithMembers(newClassDecl.Members.Insert(0, fieldDecl));
            }
            else if (awakeInNewClass.ExpressionBody != null)
            {
                var exprStmt = SyntaxFactory.ExpressionStatement(awakeInNewClass.ExpressionBody.Expression)
                    .WithAdditionalAnnotations(Formatter.Annotation);
                var convertedAwake = awakeInNewClass
                    .WithExpressionBody(null)
                    .WithSemicolonToken(default)
                    .WithBody(SyntaxFactory.Block(assignStmt, exprStmt))
                    .WithAdditionalAnnotations(Formatter.Annotation);
                newClassDecl = newClassDecl.ReplaceNode(awakeInNewClass, convertedAwake);
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

    private static string? FindExistingCachedFieldName(
        ClassDeclarationSyntax classDecl,
        MethodDeclarationSyntax? existingAwake,
        ExpressionSyntax targetExpr)
    {
        if (existingAwake == null) return null;

        var declaredFields = new HashSet<string>(
            classDecl.Members
                .OfType<FieldDeclarationSyntax>()
                .SelectMany(f => f.Declaration.Variables.Select(v => v.Identifier.ValueText)),
            StringComparer.Ordinal);

        if (declaredFields.Count == 0) return null;

        bool targetIsCameraMain = IsCameraMainSyntax(targetExpr);
        var cleanTarget = targetExpr.WithoutTrivia();

        foreach (var assign in existingAwake.DescendantNodes().OfType<AssignmentExpressionSyntax>())
        {
            if (!assign.IsKind(SyntaxKind.SimpleAssignmentExpression) || assign.Right == targetExpr)
            {
                continue;
            }

            string? assignedField = assign.Left switch
            {
                IdentifierNameSyntax id => id.Identifier.ValueText,
                MemberAccessExpressionSyntax ma when ma.Expression is ThisExpressionSyntax &&
                    ma.Name is IdentifierNameSyntax memberId => memberId.Identifier.ValueText,
                _ => null,
            };

            if (assignedField == null || !declaredFields.Contains(assignedField))
            {
                continue;
            }

            if (assign.Right.WithoutTrivia().IsEquivalentTo(cleanTarget) ||
                (targetIsCameraMain && IsCameraMainSyntax(assign.Right)))
            {
                return assignedField;
            }
        }

        return null;
    }

    private static bool IsCameraMainSyntax(ExpressionSyntax expr)
    {
        if (expr is not MemberAccessExpressionSyntax ma || ma.Name.Identifier.ValueText != "main")
        {
            return false;
        }
        if (ma.Expression is IdentifierNameSyntax id && id.Identifier.ValueText == "Camera")
        {
            return true;
        }
        return ma.Expression is MemberAccessExpressionSyntax qma &&
            qma.Name.Identifier.ValueText == "Camera" &&
            (qma.Expression is IdentifierNameSyntax uid && uid.Identifier.ValueText == "UnityEngine" ||
             qma.Expression is AliasQualifiedNameSyntax aq &&
             aq.Alias.Identifier.ValueText == "global" &&
             aq.Name.Identifier.ValueText == "UnityEngine");
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
        string preferredBaseName)
    {
        var shortName = string.IsNullOrEmpty(preferredBaseName) ? "Component" : preferredBaseName;
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
