using System.Linq;
using System.Threading.Tasks;
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
}
