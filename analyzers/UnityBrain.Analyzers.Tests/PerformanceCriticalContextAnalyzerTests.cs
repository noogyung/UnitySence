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
using UnityBrain.Analyzers.CallGraph;
using UnityBrain.Analyzers.CodeFixes;

namespace UnityBrain.Analyzers.Tests;

public sealed class PerformanceCriticalContextAnalyzerTests
{
    [Fact]
    public async Task DetectsThreeHopIndirectGetComponentInUpdateCallGraphAndFixesByCachingInAwake()
    {
        const string source = @"
using UnityEngine;

public class EnemyMover : MonoBehaviour
{
    private void Update()
    {
        StepA();
    }

    private void StepA()
    {
        StepB();
    }

    private void StepB()
    {
        var rb = GetComponent<Rigidbody>();
        _ = rb;
    }
}";

        var analyzer = new PerformanceCriticalContextAnalyzer();
        var diags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(source, analyzer);

        var ub1002 = diags.Where(d => d.Id == DiagnosticIds.UncachedComponentLookup).ToList();
        var ub1001 = diags.Where(d => d.Id == DiagnosticIds.IndirectPerformanceCriticalInvocation).ToList();

        AssertEx.Equal(1, ub1002.Count, "Expected exactly 1 UB1002 diagnostic");
        AssertEx.Equal(1, ub1001.Count, "Expected exactly 1 UB1001 diagnostic");
        AssertEx.Contains("Update() -> StepA() -> StepB()", ub1001[0].GetMessage());
        AssertEx.Contains("Update() -> StepA() -> StepB()", ub1002[0].GetMessage());

        var fixedCode = await RoslynTestHarness.ApplyCodeFixAsync(
            source,
            analyzer,
            new CacheComponentInAwakeCodeFixProvider(),
            DiagnosticIds.UncachedComponentLookup);

        AssertEx.Contains("private Rigidbody _rigidbody;", fixedCode);
        AssertEx.Contains("void Awake()", fixedCode);
        AssertEx.Contains("_rigidbody = GetComponent<Rigidbody>();", fixedCode);
        AssertEx.Contains("var rb = _rigidbody;", fixedCode);
    }

    [Fact]
    public async Task DetectsCameraMainAndFindObjectOfTypeInIndirectHelpers()
    {
        const string source = @"
using UnityEngine;

public class HudFollower : MonoBehaviour
{
    private void LateUpdate() => SyncCamera();

    private void SyncCamera()
    {
        var cam = Camera.main;
        var player = GameObject.Find(""Player"");
        _ = cam;
        _ = player;
    }
}";
        var diags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(
            source,
            new PerformanceCriticalContextAnalyzer());

        var ub1001 = diags.Where(d => d.Id == DiagnosticIds.IndirectPerformanceCriticalInvocation).ToList();
        AssertEx.Equal(2, ub1001.Count, "Expected Camera.main and GameObject.Find to report UB1001");
        AssertEx.Contains("LateUpdate() -> SyncCamera()", ub1001[0].GetMessage());
    }

    [Fact]
    public async Task AppendsToExistingAwakeMethodWithoutCreatingDuplicateAwake()
    {
        const string source = @"
using UnityEngine;

public class SimpleRunner : MonoBehaviour
{
    private int _x;
    private void Awake()
    {
        _x = 1;
    }

    private void Update()
    {
        var anim = GetComponent<Animator>();
        _ = anim;
    }
}";
        var fixedCode = await RoslynTestHarness.ApplyCodeFixAsync(
            source,
            new PerformanceCriticalContextAnalyzer(),
            new CacheComponentInAwakeCodeFixProvider(),
            DiagnosticIds.UncachedComponentLookup);

        AssertEx.Contains("private Animator _animator;", fixedCode);
        AssertEx.Contains("_animator = GetComponent<Animator>();", fixedCode);
        AssertEx.Contains("_x = 1;", fixedCode);
        int awakeCount = fixedCode.Split("Awake()").Length - 1;
        AssertEx.Equal(1, awakeCount, "Existing Awake() should be reused cleanly");
    }

    [Fact]
    public async Task DoesNotFlagGetComponentReachedOnlyFromStart()
    {
        const string source = @"
using UnityEngine;

public class OneShotInitializer : MonoBehaviour
{
    private void Start() => InitHelper();
    private void InitHelper()
    {
        var rb = GetComponent<Rigidbody>();
        _ = rb;
    }
}";
        var diags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(
            source,
            new PerformanceCriticalContextAnalyzer());
        AssertEx.Equal(0, diags.Length, "Start()-only GetComponent should not trigger UB1001/UB1002");
    }

    [Fact]
    public async Task ExcludesTryGetComponentAndExternalReceiverFromUB1002()
    {
        const string source = @"
using UnityEngine;

public class TriggerResponder : MonoBehaviour
{
    private void Update()
    {
        if (TryGetComponent<Rigidbody>(out var selfRb)) { _ = selfRb; }
        var go = new GameObject();
        var otherRb = go.GetComponent<Rigidbody>();
        _ = otherRb;
    }
}";
        var diags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(
            source,
            new PerformanceCriticalContextAnalyzer());
        var ub1002 = diags.Where(d => d.Id == DiagnosticIds.UncachedComponentLookup).ToArray();
        AssertEx.Equal(0, ub1002.Length, $"Expected 0 UB1002 for TryGetComponent/external receiver, got {ub1002.Length}");
    }

    [Fact]
    public async Task DetectsDirectUnity6FindApisAndCameraMainInUpdateAsUB1001()
    {
        const string source = @"
using UnityEngine;

public class DirectScanner : MonoBehaviour
{
    private void Update()
    {
        var first = Object.FindFirstObjectByType<Rigidbody>();
        var all = Object.FindObjectsByType<Rigidbody>(FindObjectsSortMode.None);
        var cam = Camera.main;
        _ = first;
        _ = all;
        _ = cam;
    }
}";

        string extendedStubs = UnityTestStubs.UnityStubsSource.Contains("FindObjectsByType", StringComparison.Ordinal)
            ? UnityTestStubs.UnityStubsSource
            : UnityTestStubs.UnityStubsSource.Contains("public class Object { }", StringComparison.Ordinal)
                ? UnityTestStubs.UnityStubsSource.Replace(
                    "public class Object { }",
                    @"public enum FindObjectsSortMode { None, InstanceID }
    public class Object
    {
        public static T FindFirstObjectByType<T>() where T : Object => default!;
        public static T FindAnyObjectByType<T>() where T : Object => default!;
        public static T[] FindObjectsByType<T>(FindObjectsSortMode sortMode) where T : Object => Array.Empty<T>();
        public static T FindObjectOfType<T>() where T : Object => default!;
    }")
                : UnityTestStubs.UnityStubsSource;

        var diags = await GetDiagnosticsWithCustomStubsAsync(
            source,
            extendedStubs,
            new PerformanceCriticalContextAnalyzer());

        var ub1001 = diags.Where(d => d.Id == DiagnosticIds.IndirectPerformanceCriticalInvocation).ToList();
        AssertEx.Equal(3, ub1001.Count, $"Expected 3 UB1001 diagnostics in Update(), got {ub1001.Count}");
        AssertEx.Contains("Object.FindFirstObjectByType", ub1001[0].GetMessage());
        AssertEx.Contains("Update()", ub1001[0].GetMessage());
        AssertEx.Contains("Object.FindObjectsByType", ub1001[1].GetMessage());
        AssertEx.Contains("Camera.main", ub1001[2].GetMessage());
    }

    private static async Task<ImmutableArray<Diagnostic>> GetDiagnosticsWithCustomStubsAsync(
        string userSource,
        string stubsSource,
        DiagnosticAnalyzer analyzer)
    {
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

        var parseOpts = new CSharpParseOptions(LanguageVersion.Latest);
        var userTree = CSharpSyntaxTree.ParseText(userSource, parseOpts, "TestScript.cs");
        var stubTree = CSharpSyntaxTree.ParseText(stubsSource, parseOpts, "UnityStubs.cs");

        var compilation = CSharpCompilation.Create(
            "TestAssembly",
            new[] { userTree, stubTree },
            refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var compilerErrors = compilation.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .ToArray();
        AssertEx.Equal(
            0,
            compilerErrors.Length,
            $"Unexpected compilation errors in test source: {string.Join("; ", compilerErrors.Select(e => e.GetMessage()))}");

        var withAnalyzers = compilation.WithAnalyzers(
            ImmutableArray.Create(analyzer),
            new AnalyzerOptions(ImmutableArray<AdditionalText>.Empty));
        var allDiags = await withAnalyzers.GetAnalyzerDiagnosticsAsync().ConfigureAwait(false);
        return allDiags
            .Where(d => d.Location.SourceTree == userTree)
            .OrderBy(d => d.Location.SourceSpan.Start)
            .ToImmutableArray();
    }

    [Fact]
    public async Task ExcludesExternalObjectAndGameObjectReceiversButFlagsSelfReceiversForUB1002()
    {
        const string source = @"
using UnityEngine;

public class ReceiverScopeChecker : MonoBehaviour
{
    private Component _other = null!;

    private void Update()
    {
        var ext1 = _other.gameObject.GetComponent<Rigidbody>();
        var ext2 = _other.GetComponent<Rigidbody>();
        var ext3 = _other.transform.GetComponent<Rigidbody>();

        var self1 = GetComponent<Rigidbody>();
        var self2 = this.gameObject.GetComponent<Rigidbody>();
        var self3 = gameObject.GetComponent<Rigidbody>();
        var self4 = this.transform.GetComponent<Rigidbody>();
        var self5 = transform.GetComponent<Rigidbody>();
        var self6 = this.GetComponent<Rigidbody>();

        _ = ext1; _ = ext2; _ = ext3;
        _ = self1; _ = self2; _ = self3; _ = self4; _ = self5; _ = self6;
    }
}";

        var diags = await RoslynTestHarness.GetAnalyzerDiagnosticsAsync(
            source,
            new PerformanceCriticalContextAnalyzer());

        var ub1002 = diags.Where(d => d.Id == DiagnosticIds.UncachedComponentLookup).ToArray();
        AssertEx.Equal(6, ub1002.Length, $"Expected 6 UB1002 diagnostics on self receivers only, got {ub1002.Length}");

        var texts = ub1002
            .Select(d => d.Location.SourceTree!.GetText().ToString(d.Location.SourceSpan))
            .ToArray();
        foreach (var text in texts)
        {
            AssertEx.False(text.Contains("_other", StringComparison.Ordinal),
                $"Did not expect UB1002 on external receiver: {text}");
        }
        AssertEx.True(texts.Any(t => t == "GetComponent<Rigidbody>()"), "Expected UB1002 for GetComponent<Rigidbody>()");
        AssertEx.True(texts.Any(t => t == "this.gameObject.GetComponent<Rigidbody>()"), "Expected UB1002 for this.gameObject.GetComponent<Rigidbody>()");
    }

    [Fact]
    public async Task DetectsCameraMainBackgroundColorInUpdateAsUB1001AndCachesInGeneratedAwake()
    {
        const string source = @"
using UnityEngine;

public class CameraFlash : MonoBehaviour
{
    private void Update()
    {
        Camera.main.backgroundColor = Color.Lerp(Color.red, Color.blue, Mathf.PingPong(Time.time, 1));
    }
}";

        string cameraStubs = BuildCameraExtendedStubs();
        var analyzer = new PerformanceCriticalContextAnalyzer();
        var diags = await GetDiagnosticsWithCustomStubsAsync(source, cameraStubs, analyzer);
        var ub1001 = diags.Where(d => d.Id == DiagnosticIds.IndirectPerformanceCriticalInvocation).ToList();
        AssertEx.Equal(1, ub1001.Count, $"Expected 1 UB1001 diagnostic for Camera.main, got {ub1001.Count}");
        AssertEx.Contains("Camera.main", ub1001[0].GetMessage());

        var fixedCode = await ApplyCodeFixWithCustomStubsAsync(
            source,
            cameraStubs,
            analyzer,
            new CacheComponentInAwakeCodeFixProvider(),
            DiagnosticIds.IndirectPerformanceCriticalInvocation);

        AssertEx.Contains("private Camera _mainCamera;", fixedCode);
        AssertEx.Contains("void Awake()", fixedCode);
        AssertEx.Contains("_mainCamera = Camera.main;", fixedCode);
        AssertEx.Contains(
            "_mainCamera.backgroundColor = Color.Lerp(Color.red, Color.blue, Mathf.PingPong(Time.time, 1));",
            fixedCode);
    }

    [Fact]
    public async Task CachesCameraMainInExistingAwakeAndAvoidsDuplicateFieldOrAssignment()
    {
        string cameraStubs = BuildCameraExtendedStubs();
        var analyzer = new PerformanceCriticalContextAnalyzer();
        var codeFix = new CacheComponentInAwakeCodeFixProvider();

        // 1. Injects into existing Awake() without creating a second Awake()
        const string existingAwakeSource = @"
using UnityEngine;

public class CameraFlashExisting : MonoBehaviour
{
    private int _x;
    private void Awake()
    {
        _x = 1;
    }

    private void Update()
    {
        Camera.main.backgroundColor = Color.Lerp(Color.red, Color.blue, Mathf.PingPong(Time.time, 1));
    }
}";
        var fixedExisting = await ApplyCodeFixWithCustomStubsAsync(
            existingAwakeSource,
            cameraStubs,
            analyzer,
            codeFix,
            DiagnosticIds.IndirectPerformanceCriticalInvocation);

        AssertEx.Contains("private Camera _mainCamera;", fixedExisting);
        AssertEx.Contains("_mainCamera = Camera.main;", fixedExisting);
        AssertEx.Contains("_x = 1;", fixedExisting);
        AssertEx.Contains("_mainCamera.backgroundColor =", fixedExisting);
        AssertEx.Equal(1, fixedExisting.Split("Awake()").Length - 1, "Existing Awake() should be reused");

        // 2. If _mainCamera and Awake() assignment are already applied, do NOT duplicate field or assignment
        const string alreadyAppliedSource = @"
using UnityEngine;

public class CameraFlashAlreadyCached : MonoBehaviour
{
    private Camera _mainCamera;
    private void Awake()
    {
        _mainCamera = Camera.main;
    }

    private void Update()
    {
        Camera.main.backgroundColor = Color.red;
    }
}";
        var fixedReused = await ApplyCodeFixWithCustomStubsAsync(
            alreadyAppliedSource,
            cameraStubs,
            analyzer,
            codeFix,
            DiagnosticIds.IndirectPerformanceCriticalInvocation);

        AssertEx.Equal(1, fixedReused.Split("private Camera _mainCamera;").Length - 1, "Field should not be duplicated");
        AssertEx.Equal(1, fixedReused.Split("_mainCamera = Camera.main;").Length - 1, "Awake assignment should not be duplicated");
        AssertEx.Contains("_mainCamera.backgroundColor = Color.red;", fixedReused);

        // 3. If an unrelated member named _mainCamera exists, avoid colliding by using _mainCamera2
        const string collisionSource = @"
using UnityEngine;

public class CameraFlashCollision : MonoBehaviour
{
    private int _mainCamera;

    private void Update()
    {
        _ = _mainCamera;
        Camera.main.backgroundColor = Color.blue;
    }
}";
        var fixedCollision = await ApplyCodeFixWithCustomStubsAsync(
            collisionSource,
            cameraStubs,
            analyzer,
            codeFix,
            DiagnosticIds.IndirectPerformanceCriticalInvocation);

        AssertEx.Contains("private Camera _mainCamera2;", fixedCollision);
        AssertEx.Contains("_mainCamera2 = Camera.main;", fixedCollision);
        AssertEx.Contains("_mainCamera2.backgroundColor = Color.blue;", fixedCollision);
    }

    private static string BuildCameraExtendedStubs()
    {
        return UnityTestStubs.UnityStubsSource.Replace(
            @"    public static class Camera
    {
        public static Component? main => null;
    }",
            @"    public struct Color
    {
        public static Color red => default;
        public static Color blue => default;
        public static Color Lerp(Color a, Color b, float t) => default;
    }
    public static class Mathf
    {
        public static float PingPong(float t, float length) => 0f;
    }
    public static class Time
    {
        public static float time => 0f;
    }
    public sealed class Camera : Behaviour
    {
        public static Camera main => null!;
        public Color backgroundColor { get; set; }
    }");
    }

    private static async Task<string> ApplyCodeFixWithCustomStubsAsync(
        string userSource,
        string stubsSource,
        DiagnosticAnalyzer analyzer,
        CodeFixProvider codeFixProvider,
        string diagnosticId)
    {
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
            .AddDocument(stubDocId, "UnityStubs.cs", SourceText.From(stubsSource))
            .AddDocument(userDocId, "TestScript.cs", SourceText.From(userSource));

        var doc = solution.GetDocument(userDocId)!;
        var compilation = await doc.Project.GetCompilationAsync().ConfigureAwait(false);
        var withAnalyzers = compilation!.WithAnalyzers(ImmutableArray.Create(analyzer));
        var diags = (await withAnalyzers.GetAnalyzerDiagnosticsAsync().ConfigureAwait(false))
            .Where(d => d.Location.SourceTree?.FilePath == "TestScript.cs")
            .Where(d => d.Id == diagnosticId)
            .ToImmutableArray();

        if (diags.IsEmpty)
        {
            throw new InvalidOperationException($"No matching diagnostic found to apply CodeFix ({diagnosticId}).");
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
}
