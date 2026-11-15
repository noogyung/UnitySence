using System.Linq;
using System.Threading.Tasks;
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
}
