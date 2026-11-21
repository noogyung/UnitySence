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
    private const string ComponentLookupEquivalenceKey = nameof(CacheComponentInAwakeCodeFixProvider);
    private const string CameraMainEquivalenceKey = nameof(CacheComponentInAwakeCodeFixProvider) + ".CameraMain";

    public override ImmutableArray<string> FixableDiagnosticIds =>
        ImmutableArray.Create(
            DiagnosticIds.UncachedComponentLookup,
            DiagnosticIds.IndirectPerformanceCriticalInvocation);

    public override FixAllProvider GetFixAllProvider() => SequentialFixAllProvider.Instance;

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
                        createChangedSolution: ct => CacheExpressionInAwakeSolutionAsync(
                            context.Document,
                            capturedInvocation,
                            capturedTypeArg,
                            baseName,
                            ct),
                        equivalenceKey: ComponentLookupEquivalenceKey),
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
                        createChangedSolution: ct => CacheExpressionInAwakeSolutionAsync(
                            context.Document,
                            capturedMemberAccess,
                            fieldType,
                            "mainCamera",
                            ct),
                        equivalenceKey: CameraMainEquivalenceKey),
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

    private static async Task<Solution> CacheExpressionInAwakeSolutionAsync(
        Document document,
        ExpressionSyntax targetExpr,
        TypeSyntax fieldType,
        string preferredBaseName,
        CancellationToken ct)
    {
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var semanticModel = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (root == null) return document.Project.Solution;

        var classDecl = targetExpr.FirstAncestorOrSelf<ClassDeclarationSyntax>();
        if (classDecl == null) return document.Project.Solution;

        var classSymbol = semanticModel?.GetDeclaredSymbol(classDecl, ct);

        var existingAwake = classDecl.Members
            .OfType<MethodDeclarationSyntax>()
            .FirstOrDefault(m => m.Identifier.ValueText == "Awake" && m.ParameterList.Parameters.Count == 0);

        Document? partialAwakeDoc = null;
        MethodDeclarationSyntax? partialAwakeMethod = null;
        if (existingAwake == null || (existingAwake.Body == null && existingAwake.ExpressionBody == null))
        {
            (partialAwakeDoc, partialAwakeMethod) = await FindPartialAwakeAsync(
                document.Project,
                classSymbol,
                classDecl,
                ct).ConfigureAwait(false);
        }

        var effectiveAwake = (existingAwake != null && (existingAwake.Body != null || existingAwake.ExpressionBody != null))
            ? existingAwake
            : partialAwakeMethod ?? existingAwake;

        var existingCachedField = FindExistingCachedFieldName(classDecl, classSymbol, effectiveAwake, targetExpr);
        if (existingCachedField != null)
        {
            var reusedIdentifier = SyntaxFactory.IdentifierName(existingCachedField);
            var reusedClassDecl = classDecl.ReplaceNode(
                targetExpr,
                reusedIdentifier.WithTriviaFrom(targetExpr));
            var reusedRoot = root.ReplaceNode(classDecl, reusedClassDecl);
            var reusedDoc = document.WithSyntaxRoot(reusedRoot);
            var formattedReused = await Formatter.FormatAsync(reusedDoc, Formatter.Annotation, cancellationToken: ct).ConfigureAwait(false);
            return formattedReused.Project.Solution;
        }

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

        if (awakeInNewClass != null && (awakeInNewClass.Body != null || awakeInNewClass.ExpressionBody != null))
        {
            var updatedAwake = AddAssignmentToAwakeMethod(awakeInNewClass, assignStmt);
            if (updatedAwake != null)
            {
                newClassDecl = newClassDecl.ReplaceNode(awakeInNewClass, updatedAwake);
            }
            newClassDecl = newClassDecl.WithMembers(newClassDecl.Members.Insert(0, fieldDecl));

            var updatedRoot = root.ReplaceNode(classDecl, newClassDecl);
            var formattedDoc = await Formatter.FormatAsync(
                document.WithSyntaxRoot(updatedRoot),
                Formatter.Annotation,
                cancellationToken: ct).ConfigureAwait(false);
            return formattedDoc.Project.Solution;
        }

        if (partialAwakeDoc != null && partialAwakeMethod != null)
        {
            var updatedPartialAwake = AddAssignmentToAwakeMethod(partialAwakeMethod, assignStmt);
            if (updatedPartialAwake != null)
            {
                newClassDecl = newClassDecl.WithMembers(newClassDecl.Members.Insert(0, fieldDecl));

                if (partialAwakeDoc.Id == document.Id)
                {
                    var updatedRoot = root.ReplaceNodes(
                        new SyntaxNode[] { classDecl, partialAwakeMethod },
                        (orig, _) => orig == classDecl ? newClassDecl : updatedPartialAwake);
                    var formattedDoc = await Formatter.FormatAsync(
                        document.WithSyntaxRoot(updatedRoot),
                        Formatter.Annotation,
                        cancellationToken: ct).ConfigureAwait(false);
                    return formattedDoc.Project.Solution;
                }
                else
                {
                    var updatedCallSiteRoot = root.ReplaceNode(classDecl, newClassDecl);
                    var formattedCallSiteDoc = await Formatter.FormatAsync(
                        document.WithSyntaxRoot(updatedCallSiteRoot),
                        Formatter.Annotation,
                        cancellationToken: ct).ConfigureAwait(false);

                    var solution = formattedCallSiteDoc.Project.Solution;
                    var awakeDoc = solution.GetDocument(partialAwakeDoc.Id);
                    if (awakeDoc != null)
                    {
                        var awakeRoot = await awakeDoc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
                        if (awakeRoot != null)
                        {
                            var targetAwakeNode = awakeRoot.FindNode(partialAwakeMethod.Span)
                                .FirstAncestorOrSelf<MethodDeclarationSyntax>() ?? partialAwakeMethod;
                            var updatedAwakeRoot = awakeRoot.ReplaceNode(targetAwakeNode, updatedPartialAwake);
                            var formattedAwakeDoc = await Formatter.FormatAsync(
                                awakeDoc.WithSyntaxRoot(updatedAwakeRoot),
                                Formatter.Annotation,
                                cancellationToken: ct).ConfigureAwait(false);
                            return formattedAwakeDoc.Project.Solution;
                        }
                    }

                    return solution;
                }
            }
        }

        if (awakeInNewClass != null)
        {
            var updatedPartialDecl = AddAssignmentToAwakeMethod(awakeInNewClass, assignStmt);
            if (updatedPartialDecl != null)
            {
                newClassDecl = newClassDecl.ReplaceNode(awakeInNewClass, updatedPartialDecl);
                newClassDecl = newClassDecl.WithMembers(newClassDecl.Members.Insert(0, fieldDecl));
                var updatedRoot = root.ReplaceNode(classDecl, newClassDecl);
                var formattedDoc = await Formatter.FormatAsync(
                    document.WithSyntaxRoot(updatedRoot),
                    Formatter.Annotation,
                    cancellationToken: ct).ConfigureAwait(false);
                return formattedDoc.Project.Solution;
            }
        }

        var awakeMethod = SyntaxFactory.MethodDeclaration(
            SyntaxFactory.PredefinedType(SyntaxFactory.Token(SyntaxKind.VoidKeyword)),
            SyntaxFactory.Identifier("Awake"))
            .WithModifiers(SyntaxFactory.TokenList(SyntaxFactory.Token(SyntaxKind.PrivateKeyword)))
            .WithBody(SyntaxFactory.Block(assignStmt))
            .WithAdditionalAnnotations(Formatter.Annotation);

        newClassDecl = newClassDecl.WithMembers(
            newClassDecl.Members.Insert(0, awakeMethod).Insert(0, fieldDecl));

        var finalRoot = root.ReplaceNode(classDecl, newClassDecl);
        var finalDoc = await Formatter.FormatAsync(
            document.WithSyntaxRoot(finalRoot),
            Formatter.Annotation,
            cancellationToken: ct).ConfigureAwait(false);
        return finalDoc.Project.Solution;
    }

    private static MethodDeclarationSyntax? AddAssignmentToAwakeMethod(
        MethodDeclarationSyntax awakeMethod,
        StatementSyntax assignStmt)
    {
        if (awakeMethod.Body != null)
        {
            var updatedBody = awakeMethod.Body.WithStatements(
                awakeMethod.Body.Statements.Insert(0, assignStmt));
            return awakeMethod.WithBody(updatedBody);
        }

        if (awakeMethod.ExpressionBody != null)
        {
            var exprStmt = SyntaxFactory.ExpressionStatement(awakeMethod.ExpressionBody.Expression)
                .WithAdditionalAnnotations(Formatter.Annotation);
            return awakeMethod
                .WithExpressionBody(null)
                .WithSemicolonToken(default)
                .WithBody(SyntaxFactory.Block(assignStmt, exprStmt))
                .WithAdditionalAnnotations(Formatter.Annotation);
        }

        if (awakeMethod.Modifiers.Any(m => m.IsKind(SyntaxKind.PartialKeyword)))
        {
            return awakeMethod
                .WithSemicolonToken(default)
                .WithBody(SyntaxFactory.Block(assignStmt))
                .WithAdditionalAnnotations(Formatter.Annotation);
        }

        return null;
    }

    private static async Task<(Document? AwakeDoc, MethodDeclarationSyntax? AwakeMethod)> FindPartialAwakeAsync(
        Project project,
        INamedTypeSymbol? classSymbol,
        ClassDeclarationSyntax currentClassDecl,
        CancellationToken ct)
    {
        if (classSymbol == null) return (null, null);

        var awakeSymbol = classSymbol.GetMembers("Awake")
            .OfType<IMethodSymbol>()
            .FirstOrDefault(m => m.Parameters.Length == 0);

        if (awakeSymbol == null) return (null, null);

        var targetSymbol = awakeSymbol.PartialImplementationPart ?? awakeSymbol;
        Document? fallbackDoc = null;
        MethodDeclarationSyntax? fallbackMethod = null;

        foreach (var syntaxRef in targetSymbol.DeclaringSyntaxReferences)
        {
            var doc = project.GetDocument(syntaxRef.SyntaxTree);
            if (doc == null) continue;

            var syntax = await syntaxRef.GetSyntaxAsync(ct).ConfigureAwait(false);
            if (syntax is not MethodDeclarationSyntax methodDecl) continue;

            if (methodDecl.FirstAncestorOrSelf<ClassDeclarationSyntax>() == currentClassDecl)
            {
                continue;
            }

            if (methodDecl.Body != null || methodDecl.ExpressionBody != null)
            {
                return (doc, methodDecl);
            }

            fallbackDoc ??= doc;
            fallbackMethod ??= methodDecl;
        }

        return (fallbackDoc, fallbackMethod);
    }

    private static string? FindExistingCachedFieldName(
        ClassDeclarationSyntax classDecl,
        INamedTypeSymbol? classSymbol,
        MethodDeclarationSyntax? existingAwake,
        ExpressionSyntax targetExpr)
    {
        if (existingAwake == null) return null;

        var declaredFields = new HashSet<string>(
            classDecl.Members
                .OfType<FieldDeclarationSyntax>()
                .SelectMany(f => f.Declaration.Variables.Select(v => v.Identifier.ValueText)),
            StringComparer.Ordinal);

        if (classSymbol != null)
        {
            foreach (var fieldSymbol in classSymbol.GetMembers().OfType<IFieldSymbol>())
            {
                declaredFields.Add(fieldSymbol.Name);
            }
        }

        var awakeClassDecl = existingAwake.FirstAncestorOrSelf<ClassDeclarationSyntax>();
        if (awakeClassDecl != null && awakeClassDecl != classDecl)
        {
            foreach (var field in awakeClassDecl.Members.OfType<FieldDeclarationSyntax>())
            {
                foreach (var variable in field.Declaration.Variables)
                {
                    declaredFields.Add(variable.Identifier.ValueText);
                }
            }
        }

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

    private sealed class FixTarget
    {
        public FixTarget(SyntaxAnnotation tag, string diagnosticId, int spanStart)
        {
            Tag = tag;
            DiagnosticId = diagnosticId;
            SpanStart = spanStart;
        }

        public SyntaxAnnotation Tag { get; }
        public string DiagnosticId { get; }
        public int SpanStart { get; }
    }

    private sealed class SequentialFixAllProvider : FixAllProvider
    {
        public static readonly SequentialFixAllProvider Instance = new();

        private static readonly ImmutableArray<FixAllScope> SupportedScopes =
            ImmutableArray.Create(FixAllScope.Document, FixAllScope.Project, FixAllScope.Solution);

        public override IEnumerable<FixAllScope> GetSupportedFixAllScopes() => SupportedScopes;

        public override async Task<CodeAction?> GetFixAsync(FixAllContext fixAllContext)
        {
            var diagnostics = await CollectDiagnosticsAsync(fixAllContext).ConfigureAwait(false);
            if (diagnostics.Count == 0)
            {
                return null;
            }

            var equiv = fixAllContext.CodeActionEquivalenceKey;
            var title = equiv == CameraMainEquivalenceKey
                ? "[UnityBrain] Awake()에서 모든 Camera.main 캐싱하기"
                : "[UnityBrain] Awake()에서 모든 컴포넌트 조회 캐싱하기";

            return CodeAction.Create(
                title: title,
                createChangedSolution: ct => ApplySequentialFixesAsync(fixAllContext.Solution, diagnostics, ct),
                equivalenceKey: equiv);
        }

        private static async Task<List<Diagnostic>> CollectDiagnosticsAsync(FixAllContext fixAllContext)
        {
            var rawDiagnostics = new List<Diagnostic>();

            switch (fixAllContext.Scope)
            {
                case FixAllScope.Document:
                    if (fixAllContext.Document != null)
                    {
                        var docDiags = await fixAllContext.GetDocumentDiagnosticsAsync(fixAllContext.Document).ConfigureAwait(false);
                        rawDiagnostics.AddRange(docDiags);
                    }
                    break;

                case FixAllScope.Project:
                    var projDiags = await fixAllContext.GetAllDiagnosticsAsync(fixAllContext.Project).ConfigureAwait(false);
                    rawDiagnostics.AddRange(projDiags);
                    break;

                case FixAllScope.Solution:
                    foreach (var project in fixAllContext.Solution.Projects)
                    {
                        var solProjDiags = await fixAllContext.GetAllDiagnosticsAsync(project).ConfigureAwait(false);
                        rawDiagnostics.AddRange(solProjDiags);
                    }
                    break;
            }

            var equiv = fixAllContext.CodeActionEquivalenceKey;
            var filtered = new List<Diagnostic>(rawDiagnostics.Count);
            foreach (var diag in rawDiagnostics)
            {
                if (!diag.Location.IsInSource) continue;

                if (equiv == CameraMainEquivalenceKey)
                {
                    if (diag.Id == DiagnosticIds.IndirectPerformanceCriticalInvocation)
                    {
                        filtered.Add(diag);
                    }
                }
                else if (equiv == ComponentLookupEquivalenceKey)
                {
                    if (diag.Id == DiagnosticIds.UncachedComponentLookup)
                    {
                        filtered.Add(diag);
                    }
                }
                else if (string.IsNullOrEmpty(equiv))
                {
                    if (diag.Id == DiagnosticIds.UncachedComponentLookup ||
                        diag.Id == DiagnosticIds.IndirectPerformanceCriticalInvocation)
                    {
                        filtered.Add(diag);
                    }
                }
            }

            return filtered;
        }

        private static async Task<Solution> ApplySequentialFixesAsync(
            Solution initialSolution,
            List<Diagnostic> diagnostics,
            CancellationToken ct)
        {
            var currentSolution = initialSolution;
            var byDocId = new Dictionary<DocumentId, List<Diagnostic>>();

            foreach (var diag in diagnostics)
            {
                var tree = diag.Location.SourceTree;
                if (tree == null) continue;
                var doc = initialSolution.GetDocument(tree);
                if (doc == null) continue;

                if (!byDocId.TryGetValue(doc.Id, out var list))
                {
                    list = new List<Diagnostic>();
                    byDocId[doc.Id] = list;
                }
                list.Add(diag);
            }

            var orderedDocTargets = new List<(DocumentId DocId, List<FixTarget> Targets)>();

            foreach (var kvp in byDocId)
            {
                var docId = kvp.Key;
                var doc = currentSolution.GetDocument(docId);
                if (doc == null) continue;

                var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
                if (root == null) continue;

                SemanticModel? semanticModel = null;
                var nodeToTag = new Dictionary<ExpressionSyntax, SyntaxAnnotation>();
                var docTargets = new List<FixTarget>();

                foreach (var diag in kvp.Value)
                {
                    var node = root.FindNode(diag.Location.SourceSpan, getInnermostNodeForTie: true);

                    if (diag.Id == DiagnosticIds.UncachedComponentLookup)
                    {
                        var invocation = node.FirstAncestorOrSelf<InvocationExpressionSyntax>();
                        if (invocation == null) continue;
                        var typeArg = ExtractGenericTypeArgument(invocation);
                        if (typeArg == null || string.IsNullOrWhiteSpace(typeArg.ToString())) continue;

                        if (!nodeToTag.TryGetValue(invocation, out var tag))
                        {
                            tag = new SyntaxAnnotation("UnityBrainFixAll", Guid.NewGuid().ToString("N"));
                            nodeToTag[invocation] = tag;
                            docTargets.Add(new FixTarget(tag, diag.Id, diag.Location.SourceSpan.Start));
                        }
                    }
                    else if (diag.Id == DiagnosticIds.IndirectPerformanceCriticalInvocation)
                    {
                        var memberAccess = node.FirstAncestorOrSelf<MemberAccessExpressionSyntax>();
                        if (memberAccess == null || memberAccess.Name.Identifier.ValueText != "main")
                        {
                            continue;
                        }

                        semanticModel ??= await doc.GetSemanticModelAsync(ct).ConfigureAwait(false);
                        if (semanticModel == null) continue;

                        if (semanticModel.GetSymbolInfo(memberAccess, ct).Symbol is not IPropertySymbol prop ||
                            prop.Name != "main" ||
                            prop.ContainingType.ToDisplayString() != "UnityEngine.Camera")
                        {
                            continue;
                        }

                        if (!nodeToTag.TryGetValue(memberAccess, out var tag))
                        {
                            tag = new SyntaxAnnotation("UnityBrainFixAll", Guid.NewGuid().ToString("N"));
                            nodeToTag[memberAccess] = tag;
                            docTargets.Add(new FixTarget(tag, diag.Id, diag.Location.SourceSpan.Start));
                        }
                    }
                }

                if (nodeToTag.Count > 0)
                {
                    var annotatedRoot = root.ReplaceNodes(
                        nodeToTag.Keys,
                        (orig, _) => orig.WithAdditionalAnnotations(nodeToTag[orig]));
                    currentSolution = currentSolution.WithDocumentSyntaxRoot(docId, annotatedRoot);
                    docTargets.Sort((a, b) => b.SpanStart.CompareTo(a.SpanStart));
                    orderedDocTargets.Add((docId, docTargets));
                }
            }

            foreach (var (docId, targets) in orderedDocTargets)
            {
                foreach (var target in targets)
                {
                    ct.ThrowIfCancellationRequested();

                    var doc = currentSolution.GetDocument(docId);
                    if (doc == null) continue;

                    var root = await doc.GetSyntaxRootAsync(ct).ConfigureAwait(false);
                    if (root == null) continue;

                    var expr = root.GetAnnotatedNodes(target.Tag).OfType<ExpressionSyntax>().FirstOrDefault();
                    if (expr == null) continue;

                    if (target.DiagnosticId == DiagnosticIds.UncachedComponentLookup &&
                        expr is InvocationExpressionSyntax invocation)
                    {
                        var typeArg = ExtractGenericTypeArgument(invocation);
                        if (typeArg == null || string.IsNullOrWhiteSpace(typeArg.ToString())) continue;

                        var baseName = ExtractCleanTypeIdentifier(typeArg);
                        if (string.IsNullOrEmpty(baseName))
                        {
                            baseName = "Component";
                        }

                        currentSolution = await CacheExpressionInAwakeSolutionAsync(
                            doc,
                            invocation,
                            typeArg,
                            baseName,
                            ct).ConfigureAwait(false);
                    }
                    else if (target.DiagnosticId == DiagnosticIds.IndirectPerformanceCriticalInvocation &&
                             expr is MemberAccessExpressionSyntax memberAccess)
                    {
                        var fieldType = ResolveCameraFieldType(root, memberAccess);
                        currentSolution = await CacheExpressionInAwakeSolutionAsync(
                            doc,
                            memberAccess,
                            fieldType,
                            "mainCamera",
                            ct).ConfigureAwait(false);
                    }
                }
            }

            return currentSolution;
        }
    }
}
