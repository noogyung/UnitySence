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

    public override FixAllProvider GetFixAllProvider() => SequentialFixAllProvider.Instance;

    public override async Task RegisterCodeFixesAsync(CodeFixContext context)
    {
        if (context.Diagnostics.IsEmpty) return;

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
                title: $"[UnityBrain] \"{propertyName}\" 문자열을 static readonly int 필드로 캐싱 ({hashMethod})",
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
        var typeSymbol = semanticModel?.GetDeclaredSymbol(typeDecl, ct);
        string fieldName = existingFieldName ?? GenerateUniqueFieldName(typeDecl, typeSymbol, propertyName, kind);

        var matchingCalls = FindMatchingCallsInType(
            typeDecl,
            targetLiteral,
            semanticModel,
            kind,
            propertyName,
            ct);

        var replaceMap = new Dictionary<SyntaxNode, SyntaxNode>();
        foreach (var entry in matchingCalls)
        {
            var idExpr = SyntaxFactory.IdentifierName(fieldName);
            if (entry.LiteralNode.Parent is ArgumentSyntax argSyntax && argSyntax.NameColon != null)
            {
                if (!string.IsNullOrEmpty(entry.IntOverloadFirstParamName))
                {
                    var updatedNameColon = argSyntax.NameColon.WithName(
                        SyntaxFactory.IdentifierName(entry.IntOverloadFirstParamName).WithTriviaFrom(argSyntax.NameColon.Name));
                    var updatedArg = argSyntax
                        .WithNameColon(updatedNameColon)
                        .WithExpression(idExpr.WithTriviaFrom(entry.LiteralNode));
                    replaceMap[argSyntax] = updatedArg;
                }
                else
                {
                    replaceMap[argSyntax] = argSyntax
                        .WithNameColon(null)
                        .WithExpression(idExpr.WithTriviaFrom(entry.LiteralNode))
                        .WithLeadingTrivia(argSyntax.GetLeadingTrivia());
                }
            }
            else
            {
                replaceMap[entry.LiteralNode] = idExpr.WithTriviaFrom(entry.LiteralNode);
            }
        }

        var newTypeDecl = typeDecl.ReplaceNodes(
            replaceMap.Keys,
            (orig, _) => replaceMap[orig]);

        if (existingFieldName == null)
        {
            bool hasUnityEngineUsing = HasUnityEngineUsing(root, typeDecl);
            string hashCallTarget = kind == "Animator"
                ? (hasUnityEngineUsing ? "Animator.StringToHash" : "UnityEngine.Animator.StringToHash")
                : (hasUnityEngineUsing ? "Shader.PropertyToID" : "UnityEngine.Shader.PropertyToID");

            string eol = DetectEol(root);
            string quotedName = SymbolDisplay.FormatLiteral(propertyName, quote: true);
            var fieldDecl = SyntaxFactory.ParseMemberDeclaration(
                $"private static readonly int {fieldName} = {hashCallTarget}({quotedName});{eol}")!
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

    private sealed record MatchingLiteralEntry(
        LiteralExpressionSyntax LiteralNode,
        string? IntOverloadFirstParamName);

    private static List<MatchingLiteralEntry> FindMatchingCallsInType(
        TypeDeclarationSyntax typeDecl,
        LiteralExpressionSyntax targetLiteral,
        SemanticModel? model,
        string kind,
        string propertyName,
        CancellationToken ct)
    {
        var entries = new List<MatchingLiteralEntry>();
        var seen = new HashSet<LiteralExpressionSyntax>();

        string? ResolveIntParamName(IMethodSymbol? called)
        {
            if (called == null) return null;
            return UncachedShaderOrAnimatorIdAnalyzer.FindMatchingIntOverload(called)?.Parameters.FirstOrDefault()?.Name;
        }

        if (targetLiteral.FirstAncestorOrSelf<InvocationExpressionSyntax>() is { } targetInv && model != null &&
            model.GetSymbolInfo(targetInv, ct).Symbol is IMethodSymbol targetCalled)
        {
            entries.Add(new MatchingLiteralEntry(targetLiteral, ResolveIntParamName(targetCalled)));
        }
        else
        {
            entries.Add(new MatchingLiteralEntry(targetLiteral, null));
        }
        seen.Add(targetLiteral);

        if (model == null) return entries;

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
                !seen.Contains(lit) &&
                lit.Token.ValueText == propertyName)
            {
                seen.Add(lit);
                entries.Add(new MatchingLiteralEntry(lit, ResolveIntParamName(called)));
            }
        }

        return entries;
    }

    private static string? FindExistingCachedFieldName(
        TypeDeclarationSyntax typeDecl,
        string hashMethodName,
        string propertyName)
    {
        foreach (var field in typeDecl.Members.OfType<FieldDeclarationSyntax>())
        {
            if (!field.Modifiers.Any(m => m.IsKind(SyntaxKind.StaticKeyword)))
            {
                continue;
            }
            if (field.Declaration.Type.ToString() != "int" &&
                field.Declaration.Type.ToString() != "System.Int32" &&
                field.Declaration.Type.ToString() != "Int32")
            {
                continue;
            }
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

    private static bool HasUnityEngineUsing(SyntaxNode root, TypeDeclarationSyntax contextNode)
    {
        static bool IsDirectUnityEngineUsing(UsingDirectiveSyntax u) =>
            u.Alias == null &&
            u.StaticKeyword.IsKind(SyntaxKind.None) &&
            u.Name?.ToString() == "UnityEngine";

        for (SyntaxNode? cur = contextNode; cur != null; cur = cur.Parent)
        {
            if (cur is BaseNamespaceDeclarationSyntax ns && ns.Usings.Any(IsDirectUnityEngineUsing))
            {
                return true;
            }
            if (cur is CompilationUnitSyntax cu && cu.Usings.Any(IsDirectUnityEngineUsing))
            {
                return true;
            }
        }
        if (root is CompilationUnitSyntax rootCu && rootCu.Usings.Any(IsDirectUnityEngineUsing))
        {
            return true;
        }
        return false;
    }

    private static string DetectEol(SyntaxNode root)
    {
        var text = root.ToFullString();
        return text.IndexOf("\r\n", StringComparison.Ordinal) >= 0 ? "\r\n" : "\n";
    }

    private static string GenerateUniqueFieldName(
        TypeDeclarationSyntax typeDecl,
        INamedTypeSymbol? typeSymbol,
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

        var existingNames = new HashSet<string>(
            typeDecl.Members
                .SelectMany(m => m switch
                {
                    FieldDeclarationSyntax f => f.Declaration.Variables.Select(v => v.Identifier.ValueText),
                    PropertyDeclarationSyntax p => new[] { p.Identifier.ValueText },
                    MethodDeclarationSyntax md => new[] { md.Identifier.ValueText },
                    _ => Array.Empty<string>(),
                }),
            StringComparer.Ordinal);

        for (var cur = typeSymbol; cur != null; cur = cur.BaseType)
        {
            foreach (var m in cur.GetMembers())
            {
                existingNames.Add(m.Name);
            }
        }

        string candidate = baseName;
        int n = 2;
        while (existingNames.Contains(candidate))
        {
            candidate = $"{baseName}{n}";
            n++;
        }

        return candidate;
    }

    private sealed class FixTarget
    {
        public FixTarget(SyntaxAnnotation tag, string kind, string propertyName, int spanStart)
        {
            Tag = tag;
            Kind = kind;
            PropertyName = propertyName;
            SpanStart = spanStart;
        }

        public SyntaxAnnotation Tag { get; }
        public string Kind { get; }
        public string PropertyName { get; }
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
            var equiv = fixAllContext.CodeActionEquivalenceKey;
            if (!string.IsNullOrEmpty(equiv) && equiv != nameof(ExtractPropertyToIdCodeFixProvider))
            {
                return null;
            }

            var diagnostics = await CollectDiagnosticsAsync(fixAllContext).ConfigureAwait(false);
            if (diagnostics.Count == 0)
            {
                return null;
            }

            return CodeAction.Create(
                title: "[UnityBrain] 모든 셰이더/애니메이터 문자열을 static readonly int 필드로 캐싱",
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

            var filtered = new List<Diagnostic>(rawDiagnostics.Count);
            foreach (var diag in rawDiagnostics)
            {
                if (diag.Location.IsInSource &&
                    diag.Id == DiagnosticIds.UncachedShaderOrAnimatorPropertyId)
                {
                    filtered.Add(diag);
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

                var nodeToTag = new Dictionary<LiteralExpressionSyntax, SyntaxAnnotation>();
                var docTargets = new List<FixTarget>();

                foreach (var diag in kvp.Value)
                {
                    var node = root.FindNode(diag.Location.SourceSpan, getInnermostNodeForTie: true);
                    if (node is not LiteralExpressionSyntax literal ||
                        !literal.IsKind(SyntaxKind.StringLiteralExpression))
                    {
                        continue;
                    }

                    diag.Properties.TryGetValue(UncachedShaderOrAnimatorIdAnalyzer.PropertyKindKey, out var kind);
                    kind ??= "Shader";
                    var propertyName = literal.Token.ValueText;

                    if (!nodeToTag.TryGetValue(literal, out var tag))
                    {
                        tag = new SyntaxAnnotation("UnityBrainFixAll", Guid.NewGuid().ToString("N"));
                        nodeToTag[literal] = tag;
                        docTargets.Add(new FixTarget(tag, kind, propertyName, diag.Location.SourceSpan.Start));
                    }
                }

                if (nodeToTag.Count > 0)
                {
                    var annotatedRoot = root.ReplaceNodes(
                        nodeToTag.Keys,
                        (orig, _) => orig.WithAdditionalAnnotations(nodeToTag[orig]));
                    currentSolution = currentSolution.WithDocumentSyntaxRoot(docId, annotatedRoot);
                    docTargets.Sort((a, b) => a.SpanStart.CompareTo(b.SpanStart));
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

                    var targetLiteral = root.GetAnnotatedNodes(target.Tag)
                        .OfType<LiteralExpressionSyntax>()
                        .FirstOrDefault();
                    if (targetLiteral == null) continue;

                    var updatedDoc = await ExtractToStaticFieldAsync(
                        doc,
                        targetLiteral,
                        target.Kind,
                        target.PropertyName,
                        ct).ConfigureAwait(false);
                    currentSolution = updatedDoc.Project.Solution;
                }
            }

            return currentSolution;
        }
    }
}
