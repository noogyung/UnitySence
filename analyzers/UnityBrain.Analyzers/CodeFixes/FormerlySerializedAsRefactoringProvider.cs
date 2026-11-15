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
        if (fieldDecl == null || fieldDecl.Declaration.Variables.Count == 0)
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
            title: $"Add [FormerlySerializedAs(\"{fieldName}\")] ({DiagnosticIds.FormerlySerializedAsSuggested})",
            createChangedDocument: ct => AddFormerlySerializedAsAsync(context.Document, fieldDecl, fieldName, ct),
            equivalenceKey: nameof(FormerlySerializedAsRefactoringProvider)));
    }

    private static bool IsUnitySerializedField(IFieldSymbol field)
    {
        if (field.IsStatic || field.IsConst || field.IsReadOnly)
        {
            return false;
        }

        if (field.ContainingType == null || !UnityCallGraphHelper.DerivesFromUnityBehaviour(field.ContainingType))
        {
            return false;
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
            a.AttributeClass?.Name is "SerializeField" or "SerializeFieldAttribute");
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

    private static async Task<Document> AddFormerlySerializedAsAsync(
        Document document,
        FieldDeclarationSyntax fieldDecl,
        string fieldName,
        CancellationToken ct)
    {
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        if (root is not CompilationUnitSyntax cu) return document;

        bool hasSerializationUsing = cu.Usings.Any(u =>
            u.Name?.ToString() == "UnityEngine.Serialization");

        string attrName = "FormerlySerializedAs";
        var quoted = SymbolDisplay.FormatLiteral(fieldName, quote: true);
        var attrList = SyntaxFactory.AttributeList(
            SyntaxFactory.SingletonSeparatedList(
                SyntaxFactory.Attribute(
                    SyntaxFactory.IdentifierName(attrName),
                    SyntaxFactory.ParseAttributeArgumentList($"({quoted})"))))
            .WithAdditionalAnnotations(Formatter.Annotation);

        var leadingTrivia = fieldDecl.GetLeadingTrivia();
        var updatedField = fieldDecl
            .AddAttributeLists(attrList.WithLeadingTrivia(leadingTrivia))
            .WithAdditionalAnnotations(Formatter.Annotation);

        var newRoot = cu.ReplaceNode(fieldDecl, updatedField);
        if (!hasSerializationUsing && newRoot is CompilationUnitSyntax newCu)
        {
            var usingDirective = SyntaxFactory.UsingDirective(
                SyntaxFactory.ParseName("UnityEngine.Serialization"))
                .WithTrailingTrivia(SyntaxFactory.ElasticCarriageReturnLineFeed);
            newRoot = newCu.AddUsings(usingDirective);
        }

        return document.WithSyntaxRoot(newRoot);
    }
}
