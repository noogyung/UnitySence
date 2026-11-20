using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.CodeRefactorings;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;

namespace UnityBrain.Analyzers.Tests;

[AttributeUsage(AttributeTargets.Method)]
public sealed class FactAttribute : Attribute
{
}

public static class AssertEx
{
    public static void True(bool condition, string message = "Expected condition to be true")
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    public static void False(bool condition, string message = "Expected condition to be false")
    {
        if (condition) throw new InvalidOperationException(message);
    }

    public static void Equal<T>(T expected, T actual, string? message = null)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException(
                message ?? $"Assertion failed. Expected <{expected}>, got <{actual}>.");
        }
    }

    public static void Contains(string substring, string actual)
    {
        if (!actual.Contains(substring, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"Expected text to contain '{substring}'.\nActual:\n{actual}");
        }
    }
}

public sealed class InMemoryAdditionalText : AdditionalText
{
    private readonly SourceText _text;

    public InMemoryAdditionalText(string path, string content)
    {
        Path = path;
        _text = SourceText.From(content, Encoding.UTF8);
    }

    public override string Path { get; }

    public override SourceText? GetText(CancellationToken cancellationToken = default) => _text;
}

public static class UnityTestStubs
{
    public const string UnityStubsSource = @"
using System;
using System.Collections;

namespace UnityEngine
{
    public class Object { }
    public class Component : Object
    {
        public T GetComponent<T>() => default!;
        public bool TryGetComponent<T>(out T component) { component = default!; return false; }
    }
    public class Behaviour : Component { }
    public class MonoBehaviour : Behaviour
    {
        public void Invoke(string methodName, float time) {}
        public void InvokeRepeating(string methodName, float time, float repeatRate) {}
        public void CancelInvoke(string methodName) {}
        public bool IsInvoking(string methodName) => false;
        public object StartCoroutine(string methodName) => null!;
        public void StopCoroutine(string methodName) {}
    }
    public class ScriptableObject : Object { }
    public sealed class GameObject : Object
    {
        public string tag { get; set; } = string.Empty;
        public bool CompareTag(string tag) => false;
        public static GameObject Find(string name) => null!;
        public static GameObject FindWithTag(string tag) => null!;
        public static T FindObjectOfType<T>() where T : Object => default!;
        public static T FindAnyObjectByType<T>() where T : Object => default!;
        public T GetComponent<T>() => default!;
    }
    public class Rigidbody : Component { }
    public class Animator : Component
    {
        public void SetFloat(string name, float value) {}
        public void SetBool(string name, bool value) {}
        public void SetTrigger(string name) {}
        public void SetTrigger(int id) {}
        public void SetInteger(string name, int value) {}
        public static int StringToHash(string name) => name.GetHashCode();
    }
    public class Material : Object
    {
        public void SetFloat(string name, float value) {}
        public void SetFloat(int nameID, float value) {}
        public void SetColor(string name, int value) {}
        public bool HasProperty(string name) => false;
    }
    public static class Shader
    {
        public static int PropertyToID(string name) => name.GetHashCode();
        public static void SetGlobalFloat(string name, float value) {}
    }
    public static class Camera
    {
        public static Component? main => null;
    }
    public static class Resources
    {
        public static T Load<T>(string path) where T : Object => default!;
    }
    public sealed class WaitForSeconds
    {
        public WaitForSeconds(float seconds) {}
    }
    public static class LayerMask
    {
        public static int NameToLayer(string layerName) => 0;
        public static int GetMask(params string[] layerNames) => 0;
    }
    public static class Debug
    {
        public static void Log(object msg) {}
    }
    [AttributeUsage(AttributeTargets.Field)]
    public sealed class SerializeField : Attribute { }

    [AttributeUsage(AttributeTargets.Field)]
    public sealed class SerializeReference : Attribute { }

    namespace Serialization
    {
        [AttributeUsage(AttributeTargets.Field, AllowMultiple = true)]
        public sealed class FormerlySerializedAsAttribute : Attribute
        {
            public FormerlySerializedAsAttribute(string oldName) {}
        }
    }

    namespace SceneManagement
    {
        public static class SceneManager
        {
            public static void LoadScene(string sceneName) {}
            public static void LoadSceneAsync(string sceneName) {}
            public static object GetSceneByName(string sceneName) => null!;
        }
    }
}

namespace Unity.Burst
{
    [AttributeUsage(AttributeTargets.Class | AttributeTargets.Struct | AttributeTargets.Method)]
    public sealed class BurstCompileAttribute : Attribute { }

    [AttributeUsage(AttributeTargets.Method)]
    public sealed class BurstDiscardAttribute : Attribute { }
}
";
}

public static class RoslynTestHarness
{
    private static readonly MetadataReference[] CoreReferences = BuildCoreReferences();

    private static MetadataReference[] BuildCoreReferences()
    {
        var trusted = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty)
            .Split(System.IO.Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);
        var list = new List<MetadataReference>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in trusted)
        {
            var fileName = System.IO.Path.GetFileName(path);
            if (!fileName.StartsWith("System.", StringComparison.OrdinalIgnoreCase) &&
                !fileName.Equals("mscorlib.dll", StringComparison.OrdinalIgnoreCase) &&
                !fileName.Equals("netstandard.dll", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            if (seen.Add(path))
            {
                list.Add(MetadataReference.CreateFromFile(path));
            }
        }
        return list.ToArray();
    }

    public static async Task<ImmutableArray<Diagnostic>> GetAnalyzerDiagnosticsAsync(
        string userSource,
        DiagnosticAnalyzer analyzer,
        IEnumerable<AdditionalText>? additionalTexts = null)
    {
        var parseOpts = new CSharpParseOptions(LanguageVersion.Latest);
        var userTree = CSharpSyntaxTree.ParseText(userSource, parseOpts, "TestScript.cs");
        var stubTree = CSharpSyntaxTree.ParseText(UnityTestStubs.UnityStubsSource, parseOpts, "UnityStubs.cs");

        var compilation = CSharpCompilation.Create(
            "TestAssembly",
            new[] { userTree, stubTree },
            CoreReferences,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var opts = additionalTexts != null
            ? new AnalyzerOptions(additionalTexts.ToImmutableArray())
            : new AnalyzerOptions(ImmutableArray<AdditionalText>.Empty);

        var withAnalyzers = compilation.WithAnalyzers(ImmutableArray.Create(analyzer), opts);
        var allDiags = await withAnalyzers.GetAnalyzerDiagnosticsAsync().ConfigureAwait(false);
        return allDiags
            .Where(d => d.Location.SourceTree == userTree)
            .OrderBy(d => d.Location.SourceSpan.Start)
            .ToImmutableArray();
    }

    public static async Task<ImmutableArray<Diagnostic>> GetDiagnosticsWithSuppressorAsync(
        string userSource,
        DiagnosticSuppressor suppressor)
    {
        var parseOpts = new CSharpParseOptions(LanguageVersion.Latest);
        var userTree = CSharpSyntaxTree.ParseText(userSource, parseOpts, "TestScript.cs");
        var stubTree = CSharpSyntaxTree.ParseText(UnityTestStubs.UnityStubsSource, parseOpts, "UnityStubs.cs");

        var compilation = CSharpCompilation.Create(
            "TestAssembly",
            new[] { userTree, stubTree },
            CoreReferences,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, reportSuppressedDiagnostics: true));

        var cwaOptions = new CompilationWithAnalyzersOptions(
            options: new AnalyzerOptions(ImmutableArray<AdditionalText>.Empty),
            onAnalyzerException: null,
            concurrentAnalysis: false,
            logAnalyzerExecutionTime: false,
            reportSuppressedDiagnostics: true);
        var withAnalyzers = compilation.WithAnalyzers(ImmutableArray.Create<DiagnosticAnalyzer>(suppressor), cwaOptions);
        var allDiags = await withAnalyzers.GetAllDiagnosticsAsync().ConfigureAwait(false);
        return allDiags
            .Where(d => d.Location.SourceTree == userTree)
            .OrderBy(d => d.Location.SourceSpan.Start)
            .ToImmutableArray();
    }

    public static async Task<string> ApplyCodeFixAsync(
        string userSource,
        DiagnosticAnalyzer analyzer,
        CodeFixProvider codeFixProvider,
        string? diagnosticId = null)
    {
        using var workspace = new AdhocWorkspace();
        var projectId = ProjectId.CreateNewId();
        var stubDocId = DocumentId.CreateNewId(projectId);
        var userDocId = DocumentId.CreateNewId(projectId);

        var solution = workspace.CurrentSolution
            .AddProject(projectId, "TestProject", "TestProject", LanguageNames.CSharp)
            .WithProjectCompilationOptions(projectId, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary))
            .WithProjectParseOptions(projectId, new CSharpParseOptions(LanguageVersion.Latest))
            .AddMetadataReferences(projectId, CoreReferences)
            .AddDocument(stubDocId, "UnityStubs.cs", SourceText.From(UnityTestStubs.UnityStubsSource))
            .AddDocument(userDocId, "TestScript.cs", SourceText.From(userSource));

        var doc = solution.GetDocument(userDocId)!;
        var compilation = await doc.Project.GetCompilationAsync().ConfigureAwait(false);
        var withAnalyzers = compilation!.WithAnalyzers(ImmutableArray.Create(analyzer));
        var diags = (await withAnalyzers.GetAnalyzerDiagnosticsAsync().ConfigureAwait(false))
            .Where(d => d.Location.SourceTree?.FilePath == "TestScript.cs")
            .Where(d => diagnosticId == null || d.Id == diagnosticId)
            .ToImmutableArray();

        if (diags.IsEmpty)
        {
            throw new InvalidOperationException($"No matching diagnostic found to apply CodeFix ({diagnosticId ?? "any"}).");
        }

        var actions = new List<CodeAction>();
        var targetDiag = diags[0];
        var ctx = new CodeFixContext(
            doc,
            targetDiag,
            (action, _) => actions.Add(action),
            CancellationToken.None);

        await codeFixProvider.RegisterCodeFixesAsync(ctx).ConfigureAwait(false);
        if (actions.Count == 0)
        {
            throw new InvalidOperationException($"CodeFixProvider registered zero actions for {targetDiag.Id}.");
        }

        var ops = await actions[0].GetOperationsAsync(CancellationToken.None).ConfigureAwait(false);
        foreach (var op in ops.OfType<ApplyChangesOperation>())
        {
            op.Apply(workspace, CancellationToken.None);
        }

        var updatedDoc = workspace.CurrentSolution.GetDocument(userDocId)!;
        var text = await updatedDoc.GetTextAsync().ConfigureAwait(false);
        return text.ToString();
    }

    public static async Task<string> ApplyCodeRefactoringAsync(
        string userSource,
        int spanStart,
        CodeRefactoringProvider refactoringProvider)
    {
        using var workspace = new AdhocWorkspace();
        var projectId = ProjectId.CreateNewId();
        var stubDocId = DocumentId.CreateNewId(projectId);
        var userDocId = DocumentId.CreateNewId(projectId);

        var solution = workspace.CurrentSolution
            .AddProject(projectId, "TestProject", "TestProject", LanguageNames.CSharp)
            .WithProjectCompilationOptions(projectId, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary))
            .WithProjectParseOptions(projectId, new CSharpParseOptions(LanguageVersion.Latest))
            .AddMetadataReferences(projectId, CoreReferences)
            .AddDocument(stubDocId, "UnityStubs.cs", SourceText.From(UnityTestStubs.UnityStubsSource))
            .AddDocument(userDocId, "TestScript.cs", SourceText.From(userSource));

        var doc = solution.GetDocument(userDocId)!;
        var actions = new List<CodeAction>();
        var ctx = new CodeRefactoringContext(
            doc,
            new TextSpan(spanStart, 0),
            action => actions.Add(action),
            CancellationToken.None);

        await refactoringProvider.ComputeRefactoringsAsync(ctx).ConfigureAwait(false);
        if (actions.Count == 0)
        {
            throw new InvalidOperationException("CodeRefactoringProvider registered zero actions.");
        }

        var ops = await actions[0].GetOperationsAsync(CancellationToken.None).ConfigureAwait(false);
        foreach (var op in ops.OfType<ApplyChangesOperation>())
        {
            op.Apply(workspace, CancellationToken.None);
        }

        var updatedDoc = workspace.CurrentSolution.GetDocument(userDocId)!;
        var text = await updatedDoc.GetTextAsync().ConfigureAwait(false);
        return text.ToString();
    }
}

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        var filter = args.Length > 0 && !string.IsNullOrWhiteSpace(args[0]) ? args[0] : null;
        var asm = Assembly.GetExecutingAssembly();
        int passed = 0;
        int failed = 0;

        foreach (var type in asm.GetTypes().OrderBy(t => t.Name))
        {
            var methods = type.GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .Where(m => m.GetCustomAttribute<FactAttribute>() != null)
                .ToList();
            if (methods.Count == 0) continue;

            foreach (var method in methods)
            {
                var fullName = $"{type.Name}.{method.Name}";
                if (filter != null &&
                    !fullName.Contains(filter, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                try
                {
                    var instance = Activator.CreateInstance(type)!;
                    var result = method.Invoke(instance, null);
                    if (result is Task task)
                    {
                        await task.ConfigureAwait(false);
                    }
                    Console.WriteLine($"  PASS {fullName}");
                    passed++;
                }
                catch (Exception ex)
                {
                    var inner = ex is TargetInvocationException tie && tie.InnerException != null ? tie.InnerException : ex;
                    Console.Error.WriteLine($"  FAIL {fullName}: {inner.Message}");
                    failed++;
                }
            }
        }

        Console.WriteLine($"Analyzer Test Summary: {passed} passed, {failed} failed.");
        return failed > 0 ? 1 : 0;
    }
}
