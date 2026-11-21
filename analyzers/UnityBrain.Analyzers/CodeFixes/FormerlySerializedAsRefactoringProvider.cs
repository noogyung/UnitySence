using System;
using System.Composition;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeRefactorings;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Formatting;
using UnityBrain.Analyzers.CallGraph;

namespace UnityBrain.Analyzers.CodeFixes;

[ExportCodeRefactoringProvider(LanguageNames.CSharp, Name = nameof(FormerlySerializedAsRefactoringProvider)), Shared]
public sealed class FormerlySerializedAsRefactoringProvider : CodeRefactoringProvider
{
    public override async Task ComputeRefactoringsAsync(CodeRefactoringContext context)
    {
        var root = await context.Document.GetSyntaxRootAsync(context.CancellationToken).ConfigureAwait(false);
        if (root == null) return;

        var node = root.FindNode(context.Span, getInnermostNodeForTie: true);
        var fieldDecl = node.FirstAncestorOrSelf<FieldDeclarationSyntax>();
        if (fieldDecl == null || fieldDecl.Declaration.Variables.Count != 1)
        {
            return;
        }

        var declarator = node.FirstAncestorOrSelf<VariableDeclaratorSyntax>() ?? fieldDecl.Declaration.Variables[0];
        var model = await context.Document.GetSemanticModelAsync(context.CancellationToken).ConfigureAwait(false);
        if (model == null) return;

        if (model.GetDeclaredSymbol(declarator, context.CancellationToken) is not IFieldSymbol fieldSymbol)
        {
            return;
        }

        if (!IsUnitySerializedField(fieldSymbol))
        {
            return;
        }

        var fieldName = fieldSymbol.Name;
        if (AlreadyHasFormerlySerializedAs(fieldSymbol, fieldName))
        {
            return;
        }

        context.RegisterRefactoring(CodeAction.Create(
            title: $"[UnitySense] [FormerlySerializedAs(\"{fieldName}\")] 특성 추가 ({DiagnosticIds.FormerlySerializedAsSuggested})",
            createChangedDocument: ct => AddFormerlySerializedAsAsync(context.Document, fieldDecl, fieldName, ct),
            equivalenceKey: nameof(FormerlySerializedAsRefactoringProvider)));
    }

    private static bool IsUnitySerializedField(IFieldSymbol field)
    {
        if (field.IsStatic || field.IsConst || field.IsReadOnly)
        {
            return false;
        }

        if (field.ContainingType == null)
        {
            return false;
        }

        bool isUnityContainer = UnityCallGraphHelper.DerivesFromUnityBehaviour(field.ContainingType) ||
                                HasSerializableAttribute(field.ContainingType);
        if (!isUnityContainer)
        {
            return false;
        }

        // PropertyDrawer is not serialized by Unity asset YAML
        for (var cur = field.ContainingType.BaseType; cur != null; cur = cur.BaseType)
        {
            if (cur.ToDisplayString() == "UnityEditor.PropertyDrawer")
            {
                return false;
            }
        }

        bool hasNonSerialized = field.GetAttributes().Any(a =>
            a.AttributeClass?.Name is "NonSerializedAttribute" or "NonSerialized");
        if (hasNonSerialized)
        {
            return false;
        }

        if (field.DeclaredAccessibility == Accessibility.Public)
        {
            return true;
        }

        return field.GetAttributes().Any(a =>
            a.AttributeClass?.Name is "SerializeField" or "SerializeFieldAttribute" or
            "SerializeReference" or "SerializeReferenceAttribute");
    }

    private static bool HasSerializableAttribute(INamedTypeSymbol type)
    {
        return type.GetAttributes().Any(a =>
            a.AttributeClass?.ToDisplayString() == "System.SerializableAttribute");
    }

    private static bool AlreadyHasFormerlySerializedAs(IFieldSymbol field, string fieldName)
    {
        foreach (var attr in field.GetAttributes())
        {
            if (attr.AttributeClass?.Name is "FormerlySerializedAsAttribute" or "FormerlySerializedAs" &&
                attr.ConstructorArguments.Length == 1 &&
                attr.ConstructorArguments[0].Value is string oldName &&
                oldName == fieldName)
            {
                return true;
            }
        }
        return false;
    }

    private static bool HasDirectUnitySerializationUsing(SyntaxNode root, SyntaxNode contextNode)
    {
        static bool IsTargetUsing(UsingDirectiveSyntax u) =>
            u.Alias == null &&
            u.StaticKeyword.IsKind(SyntaxKind.None) &&
            u.Name?.ToString() == "UnityEngine.Serialization";

        for (SyntaxNode? cur = contextNode; cur != null; cur = cur.Parent)
        {
            if (cur is BaseNamespaceDeclarationSyntax ns && ns.Usings.Any(IsTargetUsing))
            {
                return true;
            }
            if (cur is CompilationUnitSyntax cu && cu.Usings.Any(IsTargetUsing))
            {
                return true;
            }
        }
        if (root is CompilationUnitSyntax rootCu && rootCu.Usings.Any(IsTargetUsing))
        {
            return true;
        }
        return false;
    }

    private static async Task<Document> AddFormerlySerializedAsAsync(
        Document document,
        FieldDeclarationSyntax fieldDecl,
        string fieldName,
        CancellationToken ct)
    {
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        if (root is not CompilationUnitSyntax cu) return document;

        bool hasSerializationUsing = HasDirectUnitySerializationUsing(cu, fieldDecl);
        string eol = cu.ToFullString().IndexOf("\r\n", StringComparison.Ordinal) >= 0 ? "\r\n" : "\n";

        var originalLeading = fieldDecl.GetLeadingTrivia();
        var indentTrivia = originalLeading.Where(t => t.IsKind(SyntaxKind.WhitespaceTrivia)).ToList();
        var indentLast = originalLeading.LastOrDefault();
        var indent = indentLast.IsKind(SyntaxKind.WhitespaceTrivia)
            ? SyntaxFactory.TriviaList(indentLast)
            : indentTrivia.Count > 0
                ? SyntaxFactory.TriviaList(indentTrivia[indentTrivia.Count - 1])
                : SyntaxFactory.TriviaList();

        string attrName = "FormerlySerializedAs";
        var quoted = SymbolDisplay.FormatLiteral(fieldName, quote: true);
        var attrList = SyntaxFactory.AttributeList(
            SyntaxFactory.SingletonSeparatedList(
                SyntaxFactory.Attribute(
                    SyntaxFactory.IdentifierName(attrName),
                    SyntaxFactory.ParseAttributeArgumentList($"({quoted})"))))
            .WithLeadingTrivia(originalLeading)
            .WithTrailingTrivia(SyntaxFactory.EndOfLine(eol))
            .WithAdditionalAnnotations(Formatter.Annotation);

        var strippedField = fieldDecl.WithLeadingTrivia(indent);
        var newLists = strippedField.AttributeLists.Insert(0, attrList);
        var updatedField = strippedField
            .WithAttributeLists(newLists)
            .WithAdditionalAnnotations(Formatter.Annotation);

        var newRoot = cu.ReplaceNode(fieldDecl, updatedField);
        if (!hasSerializationUsing && newRoot is CompilationUnitSyntax newCu)
        {
            var usingDirective = SyntaxFactory.UsingDirective(
                SyntaxFactory.ParseName("UnityEngine.Serialization"))
                .WithTrailingTrivia(SyntaxFactory.EndOfLine(eol))
                .WithAdditionalAnnotations(Formatter.Annotation);
            newRoot = newCu.AddUsings(usingDirective);
        }

        return document.WithSyntaxRoot(newRoot);
    }
}
