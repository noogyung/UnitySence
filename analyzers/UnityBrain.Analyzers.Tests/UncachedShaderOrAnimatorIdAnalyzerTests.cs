using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;
using UnityBrain.Analyzers.CodeFixes;
using UnityBrain.Analyzers.Diagnostics;

namespace UnityBrain.Analyzers.Tests;

public sealed class UncachedShaderOrAnimatorIdAnalyzerTests
{
    [Fact]
    public async Task DetectsMaterialSetFloatInUpdateAndExtractsShaderPropertyToId()
    {
        const string code = @"
using UnityEngine;

public class DissolveController : MonoBehaviour
{
    private Material _mat = null!;

    private void Update()
    {
        _mat.SetFloat(""_Cutoff"", 0.5f);
    }
}
";

        var analyzer = new UncachedShaderOrAnimatorIdAnalyzer();
        var diags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(code, analyzer);
        AssertEx.Equal(1, diags.Count(d => d.Id == DiagnosticIds.UncachedShaderOrAnimatorPropertyId));

        var fixedCode = await RoslynTestHarness.ApplyCodeFixAsync(
            code,
            analyzer,
            new ExtractPropertyToIdCodeFixProvider(),
            DiagnosticIds.UncachedShaderOrAnimatorPropertyId);

        AssertEx.Contains("Shader.PropertyToID(\"_Cutoff\")", fixedCode);
        AssertEx.Contains("CutoffId", fixedCode);
        AssertEx.Contains("_mat.SetFloat(CutoffId, 0.5f)", fixedCode);

        var postFixDiags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(fixedCode, analyzer);
        AssertEx.Equal(0, postFixDiags.Length);
    }

    [Fact]
    public async Task DetectsAnimatorStringInIndirectCriticalCallAndRepeatedNonCriticalLiteral()
    {
        const string code = @"
using UnityEngine;

public class LocomotionController : MonoBehaviour
{
    private Animator _anim = null!;

    private void Update()
    {
        ApplyLocomotion();
    }

    private void ApplyLocomotion()
    {
        _anim.SetTrigger(""Jump"");
    }

    public void ResetAll()
    {
        _anim.SetTrigger(""Attack"");
    }

    public void TriggerAttackAgain()
    {
        _anim.SetTrigger(""Attack"");
    }
}
";

        var analyzer = new UncachedShaderOrAnimatorIdAnalyzer();
        var diags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(code, analyzer);
        AssertEx.Equal(3, diags.Count(d => d.Id == DiagnosticIds.UncachedShaderOrAnimatorPropertyId));

        var fixedJump = await RoslynTestHarness.ApplyCodeFixAsync(
            code,
            analyzer,
            new ExtractPropertyToIdCodeFixProvider(),
            DiagnosticIds.UncachedShaderOrAnimatorPropertyId);

        AssertEx.Contains("Animator.StringToHash(\"Jump\")", fixedJump);
        AssertEx.Contains("_anim.SetTrigger(JumpHash)", fixedJump);
    }

    [Fact]
    public async Task ReplacesAllMatchingRepeatedLiteralsInClassWithSingleStaticField()
    {
        const string code = @"
using UnityEngine;

public class MultiCallShaderEffect : MonoBehaviour
{
    private Material _mat = null!;

    public void PhaseOne()
    {
        _mat.SetFloat(""_DissolveAmount"", 0.2f);
    }

    public void PhaseTwo()
    {
        _mat.SetFloat(""_DissolveAmount"", 0.8f);
    }

    public void OnlyOnceInNonCritical()
    {
        _mat.SetFloat(""_SingleUse"", 1.0f);
    }
}
";

        var analyzer = new UncachedShaderOrAnimatorIdAnalyzer();
        var diags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(code, analyzer);
        AssertEx.Equal(2, diags.Length);

        var fixedCode = await RoslynTestHarness.ApplyCodeFixAsync(
            code,
            analyzer,
            new ExtractPropertyToIdCodeFixProvider(),
            DiagnosticIds.UncachedShaderOrAnimatorPropertyId);

        AssertEx.Contains("Shader.PropertyToID(\"_DissolveAmount\")", fixedCode);
        AssertEx.Contains("_mat.SetFloat(DissolveAmountId, 0.2f)", fixedCode);
        AssertEx.Contains("_mat.SetFloat(DissolveAmountId, 0.8f)", fixedCode);

        var afterFix = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(fixedCode, analyzer);
        AssertEx.Equal(0, afterFix.Length);
    }

    [Fact]
    public async Task DoesNotFlagKeywordMethodsOrAlreadyCachedIdCalls()
    {
        const string code = @"
using UnityEngine;

public class SafeShaderBehaviour : MonoBehaviour
{
    private static readonly int CutoffId = Shader.PropertyToID(""_Cutoff"");
    private Material _mat = null!;

    private void Update()
    {
        _mat.SetFloat(CutoffId, 0.5f);
    }
}
";

        var analyzer = new UncachedShaderOrAnimatorIdAnalyzer();
        var diags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(code, analyzer);
        AssertEx.Equal(0, diags.Length);
    }

    [Fact]
    public async Task FixAllTwoDistinctPropertyCallsExtractsBothFieldsAndCompilesCleanly()
    {
        const string code = @"
using UnityEngine;

public class DualShaderController : MonoBehaviour
{
    private Material _mat = null!;

    private void Update()
    {
        _mat.SetFloat(""_Gloss"", 1f);
        _mat.SetColor(""_Color"", Color.white);
    }
}
";

        string stubs = UnityTestStubs.UnityStubsSource.Replace(
            @"        public void SetColor(string name, int value) {}
        public void SetColor(int nameID, int value) {}",
            @"        public void SetColor(string name, Color value) {}
        public void SetColor(int nameID, Color value) {}")
            + @"
namespace UnityEngine
{
    public struct Color
    {
        public static Color white => default;
    }
}";

        var trusted = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty)
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);
        var refs = new List<MetadataReference>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in trusted)
        {
            var fileName = Path.GetFileName(path);
            if (!fileName.StartsWith("System.", StringComparison.OrdinalIgnoreCase) &&
                !fileName.Equals("mscorlib.dll", StringComparison.OrdinalIgnoreCase) &&
                !fileName.Equals("netstandard.dll", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            if (seen.Add(path))
            {
                refs.Add(MetadataReference.CreateFromFile(path));
            }
        }

        using var workspace = new AdhocWorkspace();
        var projectId = ProjectId.CreateNewId();
        var stubDocId = DocumentId.CreateNewId(projectId);
        var userDocId = DocumentId.CreateNewId(projectId);

        var solution = workspace.CurrentSolution
            .AddProject(projectId, "TestProject", "TestProject", LanguageNames.CSharp)
            .WithProjectCompilationOptions(projectId, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary))
            .WithProjectParseOptions(projectId, new CSharpParseOptions(LanguageVersion.Latest))
            .AddMetadataReferences(projectId, refs)
            .AddDocument(stubDocId, "UnityStubs.cs", SourceText.From(stubs))
            .AddDocument(userDocId, "TestScript.cs", SourceText.From(code));
        AssertEx.True(workspace.TryApplyChanges(solution));

        var analyzer = new UncachedShaderOrAnimatorIdAnalyzer();
        var codeFix = new ExtractPropertyToIdCodeFixProvider();
        var doc = workspace.CurrentSolution.GetDocument(userDocId)!;
        var compilation = await doc.Project.GetCompilationAsync().ConfigureAwait(false);
        var withAnalyzers = compilation!.WithAnalyzers(ImmutableArray.Create<DiagnosticAnalyzer>(analyzer));
        var diags = (await withAnalyzers.GetAnalyzerDiagnosticsAsync().ConfigureAwait(false))
            .Where(d => d.Location.SourceTree?.FilePath == "TestScript.cs" &&
                        d.Id == DiagnosticIds.UncachedShaderOrAnimatorPropertyId)
            .OrderBy(d => d.Location.SourceSpan.Start)
            .ToImmutableArray();

        AssertEx.Equal(2, diags.Length, $"Expected 2 UB1003 diagnostics, got {diags.Length}");

        var actions = new List<CodeAction>();
        await codeFix.RegisterCodeFixesAsync(new CodeFixContext(
            doc,
            diags[0],
            (action, _) => actions.Add(action),
            CancellationToken.None)).ConfigureAwait(false);

        AssertEx.True(actions.Count > 0, "Expected CodeAction for UB1003");

        var fixAllProvider = codeFix.GetFixAllProvider()!;
        var fixAllContext = new FixAllContext(
            doc,
            codeFix,
            FixAllScope.Document,
            actions[0].EquivalenceKey,
            codeFix.FixableDiagnosticIds,
            new TestFixAllDiagnosticProvider(analyzer),
            CancellationToken.None);

        var fixAllAction = await fixAllProvider.GetFixAsync(fixAllContext).ConfigureAwait(false);
        AssertEx.True(fixAllAction != null, "Expected FixAll CodeAction for UB1003");

        var ops = await fixAllAction!.GetOperationsAsync(CancellationToken.None).ConfigureAwait(false);
        foreach (var op in ops.OfType<ApplyChangesOperation>())
        {
            op.Apply(workspace, CancellationToken.None);
        }

        var updatedProject = workspace.CurrentSolution.GetProject(projectId)!;
        var postCompilation = await updatedProject.GetCompilationAsync().ConfigureAwait(false);
        var compilerErrors = postCompilation!.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .ToArray();
        AssertEx.Equal(
            0,
            compilerErrors.Length,
            $"Unexpected compiler errors after FixAll: {string.Join("; ", compilerErrors.Select(e => e.GetMessage()))}");

        var postAnalyzerDiags = await postCompilation
            .WithAnalyzers(ImmutableArray.Create<DiagnosticAnalyzer>(analyzer))
            .GetAnalyzerDiagnosticsAsync()
            .ConfigureAwait(false);
        AssertEx.Equal(
            0,
            postAnalyzerDiags.Count(d => d.Location.SourceTree?.FilePath == "TestScript.cs"),
            "Expected 0 remaining UB1003 diagnostics after FixAll");

        var fixedCode = (await workspace.CurrentSolution.GetDocument(userDocId)!.GetTextAsync()).ToString();
        AssertEx.Contains("private static readonly int GlossId = Shader.PropertyToID(\"_Gloss\");", fixedCode);
        AssertEx.Contains("private static readonly int ColorId = Shader.PropertyToID(\"_Color\");", fixedCode);
        AssertEx.Contains("_mat.SetFloat(GlossId, 1f);", fixedCode);
        AssertEx.Contains("_mat.SetColor(ColorId, Color.white);", fixedCode);
    }

    private sealed class TestFixAllDiagnosticProvider : FixAllContext.DiagnosticProvider
    {
        private readonly DiagnosticAnalyzer _analyzer;

        public TestFixAllDiagnosticProvider(DiagnosticAnalyzer analyzer)
        {
            _analyzer = analyzer;
        }

        public override async Task<IEnumerable<Diagnostic>> GetDocumentDiagnosticsAsync(
            Document document,
            CancellationToken cancellationToken)
        {
            var compilation = await document.Project.GetCompilationAsync(cancellationToken).ConfigureAwait(false);
            if (compilation == null) return Array.Empty<Diagnostic>();
            var tree = await document.GetSyntaxTreeAsync(cancellationToken).ConfigureAwait(false);
            var withAnalyzers = compilation.WithAnalyzers(ImmutableArray.Create(_analyzer));
            var diags = await withAnalyzers.GetAnalyzerDiagnosticsAsync(cancellationToken).ConfigureAwait(false);
            return diags.Where(d => d.Location.SourceTree == tree).ToArray();
        }

        public override async Task<IEnumerable<Diagnostic>> GetAllDiagnosticsAsync(
            Project project,
            CancellationToken cancellationToken)
        {
            var compilation = await project.GetCompilationAsync(cancellationToken).ConfigureAwait(false);
            if (compilation == null) return Array.Empty<Diagnostic>();
            var withAnalyzers = compilation.WithAnalyzers(ImmutableArray.Create(_analyzer));
            return await withAnalyzers.GetAnalyzerDiagnosticsAsync(cancellationToken).ConfigureAwait(false);
        }

        public override Task<IEnumerable<Diagnostic>> GetProjectDiagnosticsAsync(
            Project project,
            CancellationToken cancellationToken)
        {
            return Task.FromResult<IEnumerable<Diagnostic>>(Array.Empty<Diagnostic>());
        }
    }
}
